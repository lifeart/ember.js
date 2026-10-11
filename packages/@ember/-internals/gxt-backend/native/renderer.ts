// gxt NATIVE layer — alias target for `@ember/-internals/glimmer/lib/renderer`
// (the classic VM renderer + its `@glimmer/runtime` / opcode-compiler /
// program residue: P0a lever L4, never imported in native).
//
// A render ROOT is one gxt `Root` (createRoot) with the Ember owner provided as
// gxt context (`OWNER`, read by the native component manager), rendered with
// gxt `renderComponent` inside one render transaction (DEV backtracking scope),
// then inserted at its target. Teardown is gxt's tree destruction
// (`destroyElementSync`): component destructors (Glimmer `destroyComponent` →
// willDestroy / Ember `destroy`) run, DOM is removed. Roots are tracked per
// owner, so `Renderer#debugRenderTree.capture()` (Inspector, `@ember/debug`
// captureRenderTree) sees every root rendered with that owner.
//
// Updates are not driven from here: gxt cells/formulas re-render, scheduled by
// the native host hooks (host-hooks.ts: backburner render queue).
//
//   renderComponent(component, {into, owner, args})  public `@ember/renderer` API
//   renderSettled()                                   host-hooks.ts
//   Renderer (`renderer:-dom`)                         app renderer; the route /
//                                                      outlet root (`appendOutletView`)
//                                                      is Inc 4b and renders through
//                                                      `renderRoot` below
import './install';
import { assert } from '@ember/debug';
import { getOwner } from '@ember/-internals/owner';
import {
  captureRenderTree,
  createRoot,
  destroyElementSync,
  initDOM,
  provideContext,
  RENDERED_NODES_PROPERTY,
  renderComponent as gxtRenderComponent,
  type CapturedRenderNode,
  type Root,
} from '@lifeart/gxt';
import { isDestroying, registerDestructor, unregisterDestructor } from './destroyable';
import {
  hasPendingRender,
  renderSettled,
  renderTransaction,
  resetRenderLoop,
  scheduleRevalidate,
} from './host-hooks';
import { OWNER } from './managers';
import { documentedDrop, notImplemented } from './not-implemented';

export { renderSettled };

// ---------------------------------------------------------------- roots
export class NativeRenderRoot {
  #destroyed = false;
  /** The component gxt rendered at the top of this root (set once rendered). */
  rendered: object | null = null;

  constructor(
    readonly owner: object,
    readonly root: Root,
    readonly parent: Node
  ) {}

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    rootsOf(this.owner).delete(this);
    // gxt's teardown removes only CONNECTED nodes (descendants of an already
    // removed element are skipped — its fast clear path). A root rendered into
    // a DETACHED element (renderComponent RFC) would keep its top-level nodes,
    // so collect them first and remove the leftovers after gxt's teardown.
    const leftovers =
      this.rendered !== null && !this.parent.isConnected ? topLevelNodes(this.rendered) : null;
    destroyElementSync(this.root as never, false, initDOM(this.root as never));
    if (leftovers !== null) {
      for (const node of leftovers) node.parentNode?.removeChild(node);
    }
  }
}

// The DOM nodes a rendered component placed at its own top level: its rendered
// nodes, descending into nested component / control-flow nodes (never into DOM
// children — an element takes its subtree with it).
function topLevelNodes(component: object): Node[] {
  const out: Node[] = [];
  const stack: unknown[] = [(component as Record<PropertyKey, unknown>)[RENDERED_NODES_PROPERTY]];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (current !== null && typeof current === 'object') {
      const nested = (current as Record<PropertyKey, unknown>)[RENDERED_NODES_PROPERTY];
      if (nested !== undefined) stack.push(nested);
      else if (typeof (current as Node).nodeType === 'number') out.push(current as Node);
    }
  }
  return out;
}

const ROOTS_BY_OWNER = new WeakMap<object, Set<NativeRenderRoot>>();

function rootsOf(owner: object): Set<NativeRenderRoot> {
  let roots = ROOTS_BY_OWNER.get(owner);
  if (roots === undefined) {
    roots = new Set();
    ROOTS_BY_OWNER.set(owner, roots);
  }
  return roots;
}

/**
 * Render `component` as a new root owned by `owner`, inserted into `parent`
 * before `nextSibling`. Rendering happens off-document (a fragment) inside one
 * render transaction; on failure the partial root is torn down and the error
 * re-thrown. The building block of `renderComponent` and of the app's outlet
 * root (Inc 4b).
 */
export function renderRoot(
  component: object,
  {
    owner,
    parent,
    nextSibling = null,
    args = {},
  }: { owner: object; parent: Node; nextSibling?: Node | null; args?: Record<string, unknown> }
): NativeRenderRoot {
  const document = parent.ownerDocument ?? globalThis.document;
  const root = createRoot(document);
  provideContext(root as never, OWNER, owner);
  const result = new NativeRenderRoot(owner, root, parent);
  rootsOf(owner).add(result);
  const fragment = document.createDocumentFragment();
  try {
    result.rendered = renderTransaction(() =>
      gxtRenderComponent(component as never, { owner: root, args, element: fragment as never })
    ) as unknown as object;
  } catch (error) {
    try {
      result.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'native renderer: render failed, and tearing down the partial render failed too'
      );
    }
    throw error;
  }
  parent.insertBefore(fragment, nextSibling);
  return result;
}

function captureRootsOf(owner: object): CapturedRenderNode[] {
  const roots = Array.from(rootsOf(owner), (r) => r.root);
  // Each gxt Root is a container node; its children are the rendered components.
  return captureRenderTree(roots as never).flatMap((node) => node.children);
}

// ---------------------------------------------------------------- renderComponent
interface Cursor {
  element: Element;
  nextSibling: Node | null;
}
type IntoTarget = Element | Cursor;

/**
 * The returned object from `renderComponent`
 * @public
 * @module @ember/renderer
 */
export interface RenderResult {
  /** Destroys the render tree and removes all rendered content from the element rendered into */
  destroy(): void;
}

function isElement(into: IntoTarget): into is Element {
  return (into as Node).nodeType === 1;
}

const RENDER_CACHE = new WeakMap<object, RenderResult>();

export function renderComponent(
  component: object,
  {
    owner = {},
    into,
    args,
  }: {
    into: IntoTarget;
    owner?: object;
    env?: { isInteractive?: boolean; [rendererOption: string]: unknown };
    args?: Record<string, unknown>;
  }
): RenderResult {
  // Replace a previous render into the same target (RFC 1099), else start clean.
  const existing = RENDER_CACHE.get(into);
  if (existing !== undefined) {
    existing.destroy();
  } else if (isElement(into)) {
    into.innerHTML = '';
  }
  const parent = isElement(into) ? into : into.element;
  const nextSibling = isElement(into) ? null : into.nextSibling;

  const nativeRoot = renderRoot(component, { owner, parent, nextSibling, args: args ?? {} });

  // Destroying the owner tears the render down (Ember destroyable graph).
  let ownerDestructor: (() => void) | null = () => nativeRoot.destroy();
  registerDestructor(owner, ownerDestructor);

  const result: RenderResult = {
    destroy() {
      if (ownerDestructor !== null) {
        if (!isDestroying(owner)) unregisterDestructor(owner, ownerDestructor);
        ownerDestructor = null;
      }
      nativeRoot.destroy();
      if (RENDER_CACHE.get(into) === result) RENDER_CACHE.delete(into);
    },
  };
  RENDER_CACHE.set(into, result);
  return result;
}

export function _resetRenderers(): void {
  resetRenderLoop();
}

// ---------------------------------------------------------------- Renderer
const OUTLET = 'native outlet (`appendOutletView`: route templates / {{outlet}})';
const CLASSIC_VIEWS = 'Classic `@ember/component` views';
const USE_GLIMMER = 'Use @glimmer/component (or a template-only component) instead.';

/** The application renderer (`renderer:-dom`). */
export class Renderer {
  static create(props: { _viewRegistry?: unknown }): Renderer {
    const owner = getOwner(props);
    assert('Renderer is unexpectedly missing an owner', owner);
    return new Renderer(owner, props._viewRegistry);
  }

  constructor(
    readonly owner: object,
    readonly _viewRegistry?: unknown
  ) {}

  appendOutletView(_view: unknown, _target: unknown): never {
    return notImplemented(OUTLET, '4b');
  }

  // classic-component roots / view registry: legacy (curly components dropped)
  appendTo(_view: unknown, _target: unknown): never {
    return documentedDrop(CLASSIC_VIEWS, USE_GLIMMER);
  }
  register(_view: unknown): never {
    return documentedDrop(CLASSIC_VIEWS, USE_GLIMMER);
  }
  unregister(_view: unknown): never {
    return documentedDrop(CLASSIC_VIEWS, USE_GLIMMER);
  }
  remove(_view: unknown): never {
    return documentedDrop(CLASSIC_VIEWS, USE_GLIMMER);
  }
  getElement(_view: unknown): never {
    return documentedDrop(CLASSIC_VIEWS, USE_GLIMMER);
  }
  getBounds(_view: unknown): never {
    return documentedDrop(CLASSIC_VIEWS, USE_GLIMMER);
  }

  /** Schedule a render pass (everything stale re-renders in it). */
  rerender(): void {
    scheduleRevalidate();
  }

  isValid(): boolean {
    return !hasPendingRender();
  }

  get debugRenderTree(): { capture(): CapturedRenderNode[] } {
    const { owner } = this;
    return { capture: () => captureRootsOf(owner) };
  }

  destroy(): void {
    for (const root of Array.from(rootsOf(this.owner))) root.destroy();
  }
}

/** A rendered view (classic `View` type surface; classic views are dropped). */
export interface View {
  parentView: View | null;
  renderer: Renderer;
  tagName: string | null;
  elementId: string | null;
  isDestroying: boolean;
  isDestroyed: boolean;
  [key: string]: unknown;
}
