// gxt NATIVE layer — alias target for `@ember/-internals/glimmer/lib/views/outlet`
// (registered as `view:-outlet`), plus the two outlet pieces classic Ember keeps
// in `syntax/outlet.ts` / `component-managers/{outlet,route-template}.ts` /
// `templates/outlet.ts` (design §2.2 outlet.ts):
//
//   OutletView     the router's top-level view. Holds the router's outlet state
//                  in a gxt cell: `setOutletState` = one cell write, which
//                  re-renders exactly the outlet levels whose state changed.
//                  `appendTo` schedules `renderer.appendOutletView` in the render
//                  queue like classic; the renderer renders `Outlet` as an app
//                  root (native/renderer.ts `renderRoot`).
//   Outlet         the component gxt renders for `{{outlet}}` (`$_outlet(ctx)`,
//                  G3 — registered as the gxt `outletComponent` host hook by
//                  install.ts). Reads the PARENT outlet state from the render
//                  context (`OUTLET_STATE`), renders `outlets.main.render.template`
//                  with `@model` / `@controller`, and provides its own state to
//                  the outlets below it.
//   OutletTemplate the `template:-outlet` template (a route template that renders
//                  just `{{outlet}}`): the top level and routes without a template.
//
// Classic semantics kept (syntax/outlet.ts `outletHelper`):
//   - an outlet level re-renders only when its definition is UNSTABLE — a
//     different template or controller; otherwise the rendered route stays and
//     only `@model` follows the state;
//   - once a definition has been replaced, its `@model` stays frozen (the
//     outgoing route never sees the incoming route's model);
//   - the route renders with the outlet state's owner (`render.owner`).
//
// Route templates must be COMPONENTS (`hasInternalComponentManager`): a strict
// `.gjs`/`.gts` template (gxt template function), a component class, a
// `templateOnly()` definition. A route template where `this` is the controller
// (loose `.hbs` / `precompileTemplate` / wire format) needs G6 EMBER_SELF + G10:
// it fails with an explicit `not implemented (Inc 8)` error instead of rendering
// wrongly.
//
// The outlet manages its own anchor-delimited region instead of gxt `$_dc`:
// `$_dc` leaves one anchor comment behind per swap and treats object
// definitions (`templateOnly()`) as rendered instances.
import { type InternalOwner, getOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import { schedule } from '@ember/runloop';
import {
  $_args,
  $_c,
  $_edp,
  $_fin,
  $_GET_ARGS,
  $_outlet,
  $_tpl,
  cell,
  destroyElementSync,
  effect,
  getContext,
  getTracker,
  initDOM,
  provideContext,
  registerDestructor,
  RENDERED_NODES_PROPERTY,
  renderElement,
  setTracker,
  type Cell,
} from '@lifeart/gxt';
import { hasInternalComponentManager } from './manager-api';
import { nameNode, OWNER } from './managers';
import { notImplemented } from './not-implemented';
import type { NativeRenderRoot, Renderer } from './renderer';
import { factoryForTemplate, templateFor } from './template-factory';

export interface BootEnvironment {
  hasDOM: boolean;
  isInteractive: boolean;
  _renderMode?: string;
  options: unknown;
}

/** `@ember/-internals/glimmer/lib/utils/outlet` RenderState (route.ts builds it). */
interface RenderState {
  owner: InternalOwner;
  name: string;
  controller: unknown;
  model: unknown;
  template: unknown;
}

/** `@ember/-internals/glimmer/lib/utils/outlet` OutletState (router `_setOutlets`). */
interface OutletState {
  render: RenderState | undefined;
  outlets: { main: OutletState | undefined };
}

/**
 * A live view of the outlet state one outlet level reads. Provided as an object
 * with a getter — gxt `getContext` would INVOKE a provided function once.
 * Reading `state` reads through to the OutletView cell, so it subscribes the
 * reading formula.
 */
interface OutletRef {
  readonly state: OutletState | undefined;
}

/** gxt render context key: the outlet state for the `{{outlet}}`s below a node. */
export const OUTLET_STATE: unique symbol = Symbol('ember-native-outlet-state');

const TOP_LEVEL_NAME = '-top-level';

// ---------------------------------------------------------------- render tree
// Inspector: outlet nodes become `type: 'outlet'` (name `main`), nodes rendering
// the default `{{outlet}}` route template become `type: 'route-template'` like
// classic (native/renderer.ts debugRenderTree).
const OUTLET_NODES = new WeakSet<object>();
const DEFAULT_ROUTE_NODES = new WeakSet<object>();

export function outletNodeKind(node: unknown): 'outlet' | 'route-template' | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  if (OUTLET_NODES.has(node)) return 'outlet';
  if (DEFAULT_ROUTE_NODES.has(node)) return 'route-template';
  return undefined;
}

// ---------------------------------------------------------------- definitions
// What one outlet level renders (classic `OutletDefinitionState`).
interface Definition {
  readonly name: string;
  readonly template: object;
  readonly controller: unknown;
  readonly render: RenderState;
}

function definitionOf(state: OutletState | undefined): Definition | null {
  const render = state?.render;
  if (render === undefined) return null;
  const template = render.template;
  if (template === undefined || template === null) return null;
  return { name: render.name, template: template as object, controller: render.controller, render };
}

// classic `isStable` (plus "nothing rendered / nothing to render" stays put).
function isStable(next: Definition | null, current: Definition | null): boolean {
  if (next === null || current === null) return next === current;
  return next.template === current.template && next.controller === current.controller;
}

function untracked<T>(fn: () => T): T {
  const tracker = getTracker();
  setTracker(null);
  try {
    return fn();
  } finally {
    setTracker(tracker);
  }
}

type GxtNode = Record<PropertyKey, unknown> & object;

/**
 * The `{{outlet}}` component (gxt `outletComponent` host hook). Constructed by
 * gxt (`new Outlet(args)`) as a render-tree child of the context the
 * `{{outlet}}` appears in.
 */
export function Outlet(this: GxtNode): unknown {
  // eslint-disable-next-line prefer-rest-params
  $_GET_ARGS(this as never, arguments);
  const outlet = this;
  OUTLET_NODES.add(outlet);
  nameNode(outlet, 'main');

  const parent = getContext<OutletRef>(outlet as never, OUTLET_STATE, false);
  const ref: OutletRef = {
    get state() {
      return parent?.state?.outlets.main;
    },
  };
  provideContext(outlet as never, OUTLET_STATE, ref);

  const api = initDOM(outlet as never);
  const anchor = api.comment('');
  let current: Definition | null = null;
  let rendered: GxtNode | null = null;
  let destroyed = false;
  registerDestructor(outlet, () => {
    destroyed = true;
  });
  // The anchor is always rendered, so a level that starts empty can be filled
  // in place later.
  outlet[RENDERED_NODES_PROPERTY] = [anchor];

  const renderRoute = (definition: Definition): GxtNode => {
    const { template, render } = definition;
    if (!hasInternalComponentManager(template)) {
      return notImplemented(
        `native route template for \`${definition.name}\`: a template where \`this\` is the controller (loose \`.hbs\` / \`precompileTemplate\` / wire format) needs G6 EMBER_SELF + G10 — use a strict \`.gjs\`/\`.gts\` route template (a component receiving @model / @controller)`,
        8
      );
    }
    // Routable engines render with their own owner (classic outletOwner).
    if (render.owner !== undefined) provideContext(outlet as never, OWNER, render.owner);
    // `@model` follows the state while this definition is current, then stays
    // frozen at its last value (classic).
    let model = render.model;
    const args = $_args(
      {
        model: () => (current === definition ? (model = ref.state?.render?.model) : model),
        controller: definition.controller,
      },
      false,
      $_edp as never
    );
    const node = $_c(template as never, args, outlet as never) as unknown as GxtNode;
    nameNode(node, definition.name);
    if (template === OutletTemplate) DEFAULT_ROUTE_NODES.add(node);
    return node;
  };

  const swap = (next: Definition | null): void => {
    const previous = rendered;
    rendered = null;
    current = next;
    // Outgoing route first: its destructors run and its DOM leaves.
    if (previous !== null) destroyElementSync(previous as never, false, api);
    if (next !== null) {
      rendered = renderRoute(next);
      // Before the outlet itself is inserted (first render) the parent inserts
      // our nodes; afterwards insert in place, before the anchor.
      const target = api.parent(anchor);
      if (target !== null) renderElement(api, outlet as never, target, rendered as never, anchor);
    }
    outlet[RENDERED_NODES_PROPERTY] = rendered === null ? [anchor] : [rendered, anchor];
  };

  // Re-runs whenever the outlet state this level reads changes (one gxt cell,
  // written by OutletView.setOutletState); rendering itself is untracked.
  effect(() => {
    const next = definitionOf(ref.state);
    if (destroyed || isStable(next, current)) return;
    untracked(() => swap(next));
  }, outlet);

  return $_fin(outlet[RENDERED_NODES_PROPERTY] as never, outlet as never);
}

/**
 * `template:-outlet`: the route template that renders only `{{outlet}}` — the
 * top level, and every route without a template of its own.
 */
export const OutletTemplate = $_tpl(function OutletTemplate(this: GxtNode): unknown {
  // eslint-disable-next-line prefer-rest-params
  $_GET_ARGS(this as never, arguments);
  return $_fin([$_outlet(this as never)], this as never);
});

export const outletTemplateFactory = factoryForTemplate(OutletTemplate as never);

// ---------------------------------------------------------------- OutletView
export default class OutletView {
  static extend(injections: object): typeof OutletView {
    return class extends OutletView {
      static create(options: any) {
        return super.create(options ? Object.assign({}, injections, options) : injections);
      }
    };
  }

  static reopenClass(injections: object): void {
    Object.assign(this, injections);
  }

  static create(options: {
    environment: BootEnvironment;
    application: InternalOwner;
    template: unknown;
  }): OutletView {
    const owner = getOwner(options);
    assert('OutletView is unexpectedly missing an owner', owner);
    // classic: `templateFactory(owner)`
    const template = templateFor(options.template, owner) ?? options.template;
    return new OutletView(options.environment, owner, template, options.application);
  }

  /** The top-level outlet state; `outlets.main` is the router's state (a gxt cell). */
  readonly state: OutletState;
  /** What the root outlet reads: a parent whose `outlets.main` is the top level. */
  readonly rootRef: OutletRef;
  readonly #main: Cell<OutletState | undefined>;
  #root: NativeRenderRoot | null = null;

  constructor(
    private _environment: BootEnvironment,
    public owner: InternalOwner,
    public template: unknown,
    public namespace: unknown
  ) {
    const main = cell<OutletState | undefined>(undefined, 'ember-outlet-state');
    this.#main = main;
    this.state = {
      render: { owner, name: TOP_LEVEL_NAME, controller: undefined, model: undefined, template },
      outlets: {
        get main() {
          return main.value;
        },
      },
    };
    const root: OutletState = { render: undefined, outlets: { main: this.state } };
    this.rootRef = { state: root };
  }

  appendTo(selector: string | Element): void {
    const target =
      this._environment.hasDOM && typeof selector === 'string'
        ? document.querySelector(selector)
        : selector;
    const renderer = this.owner.lookup('renderer:-dom') as Renderer;
    schedule('render', renderer, 'appendOutletView', this, target as Element);
  }

  /** Called by `Renderer#appendOutletView` with the root it rendered. */
  attachRoot(root: NativeRenderRoot): void {
    const previous = this.#root;
    this.#root = root;
    if (previous !== null) previous.destroy();
  }

  rerender(): void {
    // updates are driven by the outlet-state cell (classic: no-op as well)
  }

  setOutletState(state: OutletState): void {
    this.#main.update(state);
  }

  destroy(): void {
    const root = this.#root;
    this.#root = null;
    if (root !== null) root.destroy();
  }
}
