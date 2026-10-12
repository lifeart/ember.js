import { privatize as P } from '@ember/-internals/container/lib/registry';
import { ENV } from '@ember/-internals/environment/lib/env';
import type { InternalOwner } from '@ember/-internals/owner';
import { getOwner } from '@ember/-internals/owner';
import { guidFor } from '@ember/-internals/utils/lib/guid';
import {
  getViewElement,
  getViewId,
  setViewElement,
} from '@ember/-internals/views/lib/system/utils';
import {
  getGxtRenderer,
  installCompilePipelinePart,
  installRootComponentPart,
  installViewUtilsPart,
  getAmbientOwner,
  setAmbientOwner,
  GXT_ARGS_SYMBOL,
} from '@ember/-internals/gxt-backend/gxt-bridge';

// Lazy accessor for @lifeart/gxt symbols through the bridge. Every call site
// below is reached only from GXT-mode code paths. Avoiding a static
// `import * as _gxt from '@lifeart/gxt'` keeps the GXT runtime (and its
// module-load side effects) out of the classic bundle.
function _gxtLib(): any {
  // GXT-only. Body gated on the literal `__GXT_MODE__` so the `getGxtRenderer`
  // reference (and thus the whole gxt-bridge module) tree-shakes out of the
  // unminified classic dist — rollup folds `if (false)` to nothing but does NOT
  // drop the unreferenced declaration of this cyclic helper cluster.
  if (__GXT_MODE__) {
    return getGxtRenderer()?.gxtLib;
  }
}

// GXT-only: the render-pass hooks of gxt-backend/manager.ts. manager.ts installs
// the renderer bridge when it loads, which is before any GXT render.
function gxtRenderPass() {
  return getGxtRenderer()!.renderPass;
}

// Cached GXT DOM API for destroyElementSync
let gxtDomApi: any = null;

function getGxtDomApi() {
  if (__GXT_MODE__) {
    if (!gxtDomApi) {
      gxtDomApi = new (_gxtLib().HTMLBrowserDOMApi)(document);
    }
    return gxtDomApi;
  }
}

// Wrapper that provides the GXT DOM API
function destroyElementSync(component: any, skipDom = false) {
  if (__GXT_MODE__) {
    _gxtLib().destroyElementSync(component, skipDom, getGxtDomApi());
  }
}

// Cached GXT root context for the document
let gxtRootContext: any = null;

// Ensure GXT context is initialized before any GXT rendering
function ensureGxtContext() {
  if (__GXT_MODE__) {
    const lib = _gxtLib();
    if (!gxtRootContext) {
      gxtRootContext = lib.createRoot(document);
      // CRITICAL: Provide the rendering context with DOM API
      // This sets fastRenderingContext which is checked first by initDOM
      const domApi = getGxtDomApi();
      lib.provideContext(gxtRootContext, lib.RENDERING_CONTEXT, domApi);
      // Share this root context with gxt-backend so it reuses it instead of
      // creating new roots that pollute the shared context chain.
      getGxtRenderer()?.compilePipeline.setRootContext?.(gxtRootContext);
    }
    // Always ensure context is set before rendering
    const currentContext = lib.getParentContext();
    if (!currentContext) {
      lib.setParentContext(gxtRootContext);
    }
    return gxtRootContext;
  }
}

// GXT-only: a minimal DebugRenderTree backed by gxt's `captureRenderTree`.
// Only `.capture()` is reachable in GXT mode — the `begin`/`create`/`update`/
// `didRender`/`willDestroy`/`commit` bookkeeping lives on the classic Glimmer
// VM environment, which the GXT build does not include (see the
// `debugRenderTree` getter).
//
// gxt's `captureRenderTree()` already returns Ember-compatible
// `CapturedRenderNode[]` (gxt adds a harmless extra `template: null` field and
// always reports `type: 'component'`), so `capture()` is a straight
// pass-through. Called with no arguments, gxt discovers the render roots from
// its own component-parent registry. gxt errors propagate.
let gxtDebugRenderTree: DebugRenderTree | null = null;

function getGxtDebugRenderTree(): DebugRenderTree {
  // GXT-only. Body gated on the literal `__GXT_MODE__` so the `_gxtLib`
  // reference tree-shakes out of the classic dist.
  if (__GXT_MODE__) {
    if (!gxtDebugRenderTree) {
      const noop = (): void => {};
      gxtDebugRenderTree = {
        begin: noop,
        create: noop,
        update: noop,
        didRender: noop,
        willDestroy: noop,
        commit: noop,
        // No args → gxt discovers the render roots itself (see above).
        capture: (): CapturedRenderNode[] => _gxtLib().captureRenderTree() as CapturedRenderNode[],
      } as DebugRenderTree;
    }
    return gxtDebugRenderTree;
  }
  throw new Error('[gxt] getGxtDebugRenderTree() called outside GXT mode');
}
import { assert } from '@ember/debug';
import { _backburner, _getCurrentRunLoop } from '@ember/runloop';
import {
  associateDestroyableChild,
  destroy,
  isDestroyed,
  isDestroying,
  registerDestructor,
} from '@glimmer/destroyable';
import { DEBUG } from '@glimmer/env';
import type {
  Bounds,
  CapturedRenderNode,
  Cursor,
  DebugRenderTree,
  Environment,
  DynamicScope as GlimmerDynamicScope,
  RenderResult as GlimmerRenderResult,
  Template,
  TemplateFactory,
  EvaluationContext,
  CurriedComponent,
  TreeBuilder,
  ClassicResolver,
} from '@glimmer/interfaces';

import type { Nullable } from '@ember/-internals/utility-types';
import { artifacts } from '@glimmer/program/lib/helpers';
import { RuntimeOpImpl } from '@glimmer/program/lib/opcode';
import type { Reference } from '@glimmer/reference/lib/reference';
// The @glimmer/reference and @glimmer/validator BARREL specifiers below are
// load-bearing for the GXT dual backend: the rollup GXT alias map
// (scripts/gxt-alias-map.mjs) redirects the exact barrel key to the gxt-backend
// shim, while deep lib/* paths would resolve to the real vendored VM source and
// fork the reactive runtime in GXT builds. Do not convert them to deep imports.
// eslint-disable-next-line ember-local/no-barrel-imports
import { createConstRef, UNDEFINED_REFERENCE, valueForRef } from '@glimmer/reference';
import type { CurriedValue } from '@glimmer/runtime/lib/curried-value';
import { clientBuilder } from '@glimmer/runtime/lib/vm/element-builder';
import { createCapturedArgs, EMPTY_POSITIONAL } from '@glimmer/runtime/lib/vm/arguments';
import { curry } from '@glimmer/runtime/lib/curried-value';
import { inTransaction, runtimeOptions } from '@glimmer/runtime/lib/environment';
import { renderComponent as glimmerRenderComponent, renderMain } from '@glimmer/runtime/lib/render';
import { dict } from '@glimmer/util/lib/collections';
import { unwrapTemplate, isGxtTemplate } from './component-managers/unwrap-template';
// Namespace import MUST stay on the barrel: touchClassicBridge /
// registerClassicReactor exist only in the GXT-aliased validator shim.
// eslint-disable-next-line ember-local/no-barrel-imports
import * as _glimmerValidator from '@glimmer/validator';
// eslint-disable-next-line ember-local/no-barrel-imports
import { CURRENT_TAG, validateTag, valueForTag, type Tag } from '@glimmer/validator';
// touchClassicBridge / registerClassicReactor exist only in the GXT-aliased
// validator; fall back to no-ops in classic builds so these imports never
// break the classic bundle.
const touchClassicBridge: () => void =
  typeof (_glimmerValidator as any).touchClassicBridge === 'function'
    ? (_glimmerValidator as any).touchClassicBridge
    : () => {};
const registerClassicReactor: (cb: () => void, source?: string) => () => void =
  typeof (_glimmerValidator as any).registerClassicReactor === 'function'
    ? (_glimmerValidator as any).registerClassicReactor
    : (_: () => void, _src?: string) => () => {};
import { tagForObject } from '@ember/-internals/metal/lib/tags';
import type { SimpleDocument, SimpleElement, SimpleNode } from '@simple-dom/interface';
import type Component from './component';
import { hasDOM } from '../../browser-environment';
import type ClassicComponent from './component';
import { BOUNDS } from './component-managers/curly';
import { createRootOutlet } from './component-managers/outlet';
import { RootComponentDefinition } from './component-managers/root';
import { EmberEnvironmentDelegate } from './environment';
import ResolverImpl from './resolver';
import type { OutletState } from './utils/outlet';
import OutletView from './views/outlet';
import { makeRouteTemplate } from './component-managers/route-template';
import { EvaluationContextImpl } from '@glimmer/opcode-compiler/lib/program-context';

export type IBuilder = (env: Environment, cursor: Cursor) => TreeBuilder;

export interface View {
  parentView: Nullable<View>;
  renderer: Renderer;
  tagName: string | null;
  elementId: string | null;
  isDestroying: boolean;
  isDestroyed: boolean;
  [BOUNDS]: Bounds | null;
}

// VM-free stand-in for @glimmer/runtime's `EMPTY_POSITIONAL` (a frozen empty
// reference array), used on the GXT outlet-append path so the renderer chunk
// does not import `@glimmer/runtime/lib/vm/arguments` under __GXT_MODE__.
const EMPTY_POSITIONAL_GXT: readonly Reference[] = Object.freeze([]);

export class DynamicScope implements GlimmerDynamicScope {
  constructor(
    public view: View | null,
    public outletState: Reference<OutletState | undefined>
  ) {}

  child() {
    return new DynamicScope(this.view, this.outletState);
  }

  get(key: 'outletState'): Reference<OutletState | undefined> {
    assert(
      `Using \`-get-dynamic-scope\` is only supported for \`outletState\` (you used \`${key}\`).`,
      key === 'outletState'
    );
    return this.outletState;
  }

  set(key: 'outletState', value: Reference<OutletState | undefined>) {
    assert(
      `Using \`-with-dynamic-scope\` is only supported for \`outletState\` (you used \`${key}\`).`,
      key === 'outletState'
    );
    this.outletState = value;
    return value;
  }
}

const NO_OP = () => {};

// This wrapper logic prevents us from rerendering in case of a hard failure
// during render. This prevents infinite revalidation type loops from occuring,
// and ensures that errors are not swallowed by subsequent follow on failures.
function errorLoopTransaction(fn: () => void) {
  if (DEBUG) {
    return () => {
      let didError = true;

      try {
        fn();
        didError = false;
      } finally {
        if (didError) {
          // Noop the function so that we won't keep calling it and causing
          // infinite looping failures;
          fn = () => {
            // eslint-disable-next-line no-console
            console.warn(
              'Attempted to rerender, but the Ember application has had an unrecoverable error occur during render. You should reload the application after fixing the cause of the error.'
            );
          };
        }
      }
    };
  } else {
    return fn;
  }
}

type RootState = ClassicRootState | ComponentRootState;

class ComponentRootState {
  readonly type = 'component';

  #result: GlimmerRenderResult | undefined;
  #render: () => void;

  constructor(
    state: RendererState,
    definition: object,
    options: { into: Cursor; args?: Record<string, unknown> }
  ) {
    this.#render = errorLoopTransaction(() => {
      // ComponentRootState drives the public `renderComponent` API through the
      // Glimmer VM. In GXT mode `renderComponent` escape-hatches to
      // `_renderComponentGxt` BEFORE constructing a ComponentRootState (see the
      // `if (__GXT_MODE__) return _renderComponentGxt(...)` guard there), so this
      // class is classic-only. The `!__GXT_MODE__` gate makes the VM bindings
      // (`glimmerRenderComponent`, `state.context`, `state.builder`/`state.env`)
      // statically dead in the GXT dist so the VM render loop tree-shakes out.
      if (!__GXT_MODE__) {
        let iterator = glimmerRenderComponent(
          state.context,
          state.builder(state.env, options.into),
          state.owner,
          definition,
          options?.args
        );

        let result = (this.#result = iterator.sync());

        associateDestroyableChild(this, this.#result);

        this.#render = errorLoopTransaction(() => {
          if (isDestroying(result) || isDestroyed(result)) return;

          return result.rerender({
            alwaysRevalidate: false,
          });
        });
      } else {
        throw new Error(
          '[gxt] ComponentRootState reached in GXT mode; the GXT backend renders ' +
            'via _renderComponentGxt and ships no Glimmer VM render loop — no fallback.'
        );
      }
    });
  }

  isFor(_component: ClassicComponent): boolean {
    return false;
  }

  render(): void {
    this.#render();
  }

  destroy(): void {
    destroy(this);
  }

  get destroyed(): boolean {
    return isDestroyed(this);
  }

  get result(): GlimmerRenderResult | undefined {
    return this.#result;
  }
}

// --- ArrayProxy content → component cell bridge ---
// Maps a content array to { proxy, ownerObj, ownerKey } so that when
// notifyPropertyChange(content, '[]') fires, we can dirty the component
// cell with the proxy value (not the content array).
const _proxyContentOwners = new WeakMap<object, Set<{ proxy: any; obj: object; key: string }>>();

function _registerArrayProxyOwner(proxy: any, ownerObj: object, ownerKey: string) {
  try {
    const desc = Object.getOwnPropertyDescriptor(proxy, 'content');
    if (!desc || desc.get) return; // content is a CP, skip
    const content = desc.value;
    if (!content || !Array.isArray(content)) return;
    let owners = _proxyContentOwners.get(content);
    if (!owners) {
      owners = new Set();
      _proxyContentOwners.set(content, owners);
    }
    owners.add({ proxy, obj: ownerObj, key: ownerKey });
  } catch {
    /* ignore */
  }
}

// Lazily registers (once) an after-hook on the GXT re-render trigger that runs
// after the trigger's own work: when an ArrayProxy's content array changes,
// it dirties the owning component cell with the proxy.
let _triggerReRenderHostHookInstalled = false;
function _ensureTriggerReRenderPatched() {
  if (__GXT_MODE__) {
    if (_triggerReRenderHostHookInstalled) return;
    const cp = getGxtRenderer()?.compilePipeline;
    if (!cp || typeof cp.addAfterTriggerReRender !== 'function') return;
    const _cellFor = getGxtRenderer()?.compilePipeline.cellFor;
    if (!_cellFor) return;
    _triggerReRenderHostHookInstalled = true;
    cp.addAfterTriggerReRender(function (obj: object, keyName: string) {
      // If this is a '[]' or 'length' notification on a native array that is
      // the content of an ArrayProxy, dirty the component cell with the proxy.
      if ((keyName === '[]' || keyName === 'length') && Array.isArray(obj)) {
        const owners = _proxyContentOwners.get(obj);
        if (owners) {
          for (const { proxy, obj: ownerObj, key: ownerKey } of owners) {
            try {
              const c = _cellFor(ownerObj, ownerKey, /* skipDefine */ true);
              if (c) c.update(proxy); // Update with proxy, not content array
            } catch {
              /* ignore */
            }
          }
        }
      }
    });
  }
}

class ClassicRootState {
  readonly type = 'classic';
  public id: string;
  public result: GlimmerRenderResult | undefined;
  public destroyed: boolean;
  public render: () => void;
  readonly #getContext: () => EvaluationContext;
  // Resolved lazily — touching it forces the VM evaluation context (see the
  // constructor's getContext doc). No internal reader remains; kept for
  // parity with the classic RootState surface.
  get env(): Environment {
    return this.#getContext().env;
  }
  public isGxt: boolean = false; // Track if this root uses GXT templates
  public isOutletView: boolean = false; // Track if this root is an OutletView
  // True while the most recent render() attempt threw before completing.
  // Such a root never wired its reactivity (gxtComponentTag stays unset), so
  // the tag-based dirty selection in _gxtForceEmberRerender cannot see it;
  // the flag makes the next force pass retry the full root render. Classic
  // production recovers after an initial-render error this way ("it
  // rerenders after error in production"); in DEBUG errorLoopTransaction has
  // already nooped the render fn, so the retry is a warn-noop and dev keeps
  // its "does not rerender after error" behavior.
  public gxtRenderIncomplete: boolean = false;
  public gxtComponentTag: Tag | null = null; // Track component's dirty tag for GXT reactivity
  public gxtLastTagValue: number = 0; // Last known tag value for comparison

  constructor(
    public root: Component | OutletView,
    // Lazy: resolving the context forces the VM evaluation context (4MB
    // program heap) into existence — see `createContext` on RendererData.
    // Under __GXT_MODE__ the GXT branch below never needs it; only the
    // classic Glimmer fallback branch resolves the thunk.
    getContext: () => EvaluationContext,
    owner: object,
    template: Template,
    self: Reference<unknown>,
    parentElement: SimpleElement,
    dynamicScope: DynamicScope,
    builder: IBuilder
  ) {
    assert(
      `You cannot render \`${valueForRef(self)}\` without a template.`,
      template !== undefined
    );

    this.id = root instanceof OutletView ? guidFor(root) : getViewId(root);
    this.result = undefined;
    this.destroyed = false;
    this.#getContext = getContext;

    // Two separate `errorLoopTransaction` calls, not one callback branching on
    // `__GXT_MODE__`: rollup keeps every binding a callback passed there refers
    // to (the helper reassigns its parameter), even in a folded branch, so a
    // shared callback would keep the GXT helpers in the classic build.
    if (__GXT_MODE__) {
      this.render = errorLoopTransaction(() => {
        // GXT: guard against infinite render depth (e.g., engine mounting loops).
        const depth = _gxtRenderDepth || 0;
        if (depth > 20) {
          // eslint-disable-next-line no-console
          console.warn('[gxt] Max render depth exceeded, skipping render');
          return;
        }
        _gxtRenderDepth = depth + 1;
        try {
          this.gxtRenderIncomplete = false;
          // Set the ambient owner for the GXT manager system to access (classic
          // Glimmer threads the owner through dynamicScope instead).
          setAmbientOwner(owner);

          if (isGxtTemplate(template)) {
            // Mark this root as using GXT templates (for forced re-render)
            this.isGxt = true;

            // CRITICAL: Ensure GXT context is set up before any GXT rendering
            // This provides the parent context chain that GXT's $_if, $_c, etc. need
            ensureGxtContext();

            // Use gxt rendering for gxt templates
            // Get the component context from self reference
            const componentContext = valueForRef(self);

            // Create a minimal result object for compatibility
            const gxtResult = {
              rerender: () => {
                // gxt handles re-rendering internally via reactivity
              },
              destroy: () => {
                // Cleanup handled by gxt's destroyable system
                destroyElementSync(parentElement);
              },
            };

            this.result = gxtResult as any;
            associateDestroyableChild(owner, gxtResult as any);

            // Track the actual render target (may be a wrapper element for classic components)
            let actualRenderTarget: SimpleElement = parentElement;

            // Check if template has a render method (runtime-compiled gxt template)
            if (typeof (template as any).render === 'function') {
              // For gxt templates, use the root view directly (e.g., OutletView)
              // The root parameter has the state we need
              let renderContext;

              // Debug: log what root looks like

              if (root && 'state' in root && 'ref' in root) {
                // This is an OutletView - transform to expected format
                this.isOutletView = true;
                const outletView = root as any;
                renderContext = {
                  rootState: {
                    root: {
                      ref: outletView.ref,
                      template: outletView.state?.template || outletView.template,
                    },
                    render: {
                      owner: outletView.owner,
                    },
                  },
                };
              } else if (root && 'layoutName' in root) {
                // This is a ClassicComponent (from RenderingTestCase)
                const component = root as any;

                // Use the component directly as render context (not Object.create).
                // Install cell getter/setters directly on the component so GXT's
                // native tracking ($_if, $_each, etc.) works properly.
                renderContext = component;

                // Add GXT-required symbols for template rendering
                renderContext[GXT_ARGS_SYMBOL] = component.args || {};
                renderContext[_gxtLib().$SLOTS_SYMBOL] = {};
                renderContext.$fw = [[], [], []];
                renderContext.owner = owner;

                // Install cell-backed getter/setters on the component for ALL
                // data properties. Use skipDefine=false so GXT's native formula
                // tracking (in $_if, $_each, etc.) picks up cell.value reads.
                const _cellFor = getGxtRenderer()?.compilePipeline.cellFor;
                const _registerArrayOwner = getGxtRenderer()?.compilePipeline.registerArrayOwner;
                _ensureTriggerReRenderPatched();
                if (_cellFor) {
                  const skipProps = new Set([
                    'args',
                    'constructor',
                    'element',
                    'tagName',
                    'layoutName',
                    'layout',
                    'elementId',
                    'isView',
                    'isComponent',
                    'concatenatedProperties',
                    'mergedProperties',
                    'classNames',
                    'classNameBindings',
                    'attributeBindings',
                    'positionalParams',
                    '_states',
                    'renderer',
                    '__dispatcher',
                    'parentView',
                    '_state',
                    '_currentState',
                    'target',
                    '_debugContainerKey',
                  ]);
                  for (const key in component) {
                    if (typeof key !== 'string' || key.startsWith('_') || skipProps.has(key))
                      continue;
                    try {
                      // Walk the prototype chain to find the descriptor. `for...in`
                      // iterates inherited enumerable keys too, but
                      // `Object.getOwnPropertyDescriptor(component, key)` returns
                      // `undefined` for inherited props. Without walking, we fail
                      // to detect mixin-installed computed-property getter/setter
                      // pairs (e.g., `actionContextObject` from TargetActionSupport)
                      // and install a cellFor whose cell re-reads the CP through
                      // `comp[key]`, recursing forever
                      // (cell.value -> cell.__fn() -> comp[key] -> cell.value ...).
                      let desc: PropertyDescriptor | undefined;
                      let obj: any = component;
                      while (obj && obj !== Object.prototype) {
                        desc = Object.getOwnPropertyDescriptor(obj, key);
                        if (desc) break;
                        obj = Object.getPrototypeOf(obj);
                      }
                      if (desc && (desc.get || desc.set)) continue;
                      if (desc && desc.configurable === false) continue;
                      const value = component[key];
                      if (typeof value === 'function') continue;
                      _cellFor(component, key, /* skipDefine */ false);
                      // Register array owner for KVO array mutation tracking
                      if (_registerArrayOwner && Array.isArray(value)) {
                        _registerArrayOwner(value, component, key);
                      }
                      // For ArrayProxy values, register the proxy in a separate map
                      // so that when its content array fires notifyPropertyChange,
                      // we can dirty the component cell with the proxy (not the content).
                      if (
                        _registerArrayOwner &&
                        value &&
                        typeof value === 'object' &&
                        typeof value.objectAt === 'function' &&
                        !Array.isArray(value)
                      ) {
                        _registerArrayProxyOwner(value, component, key);
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                }
              } else {
                // Fallback to the component context
                renderContext = componentContext;
              }

              // For classic components with a wrapper element (tagName !== ''),
              // create the wrapper with Ember-specific attributes before GXT renders
              if (root && 'tagName' in root) {
                const component = root as any;
                const tagName = component.tagName;

                // Only create wrapper if tagName is truthy (non-empty string)
                // tagless components have tagName set to '' or are null/undefined
                if (tagName && tagName !== '') {
                  const wrapperTag = tagName; // Already checked it's truthy
                  const wrapper = document.createElement(wrapperTag);

                  // Set the Ember-specific id attribute
                  const elementId = component.elementId || guidFor(component);
                  wrapper.id = elementId;

                  // Build class list starting with ember-view
                  const classList: string[] = ['ember-view'];

                  // Add classNames if present
                  if (component.classNames && Array.isArray(component.classNames)) {
                    classList.push(...component.classNames);
                  }

                  // Add classNameBindings values if present
                  if (component.classNameBindings && Array.isArray(component.classNameBindings)) {
                    for (const binding of component.classNameBindings) {
                      // Parse simple bindings like 'isEnabled:enabled:disabled' or 'propertyName'
                      const parts = binding.split(':');
                      const propName = parts[0];
                      const propValue = component[propName];

                      if (parts.length === 1) {
                        // Just property name - add as class if truthy
                        if (propValue) {
                          const className =
                            typeof propValue === 'string'
                              ? propValue
                              : propName.replace(/([A-Z])/g, '-$1').toLowerCase();
                          classList.push(className);
                        }
                      } else if (parts.length >= 2) {
                        // property:trueClass or property:trueClass:falseClass
                        if (propValue && parts[1]) {
                          classList.push(parts[1]);
                        } else if (!propValue && parts[2]) {
                          classList.push(parts[2]);
                        }
                      }
                    }
                  }

                  wrapper.className = classList.join(' ');

                  // Add ariaRole if present
                  if (component.ariaRole) {
                    wrapper.setAttribute('role', component.ariaRole);
                  }

                  // Apply attributeBindings if present
                  if (component.attributeBindings && Array.isArray(component.attributeBindings)) {
                    for (const binding of component.attributeBindings) {
                      const [propName, attrName] = binding.includes(':')
                        ? binding.split(':')
                        : [binding, binding];
                      const value = component[propName];
                      if (
                        value !== undefined &&
                        value !== null &&
                        attrName !== 'id' &&
                        attrName !== 'class'
                      ) {
                        // For 'value' on input/textarea/select, use DOM property (not HTML attribute)
                        const isPropertyOnly =
                          attrName === 'value' &&
                          (wrapper.tagName === 'INPUT' ||
                            wrapper.tagName === 'TEXTAREA' ||
                            wrapper.tagName === 'SELECT');
                        if (isPropertyOnly) {
                          (wrapper as any)[attrName] = String(value);
                        } else if (typeof value === 'boolean') {
                          if (value) {
                            wrapper.setAttribute(attrName, '');
                          }
                        } else {
                          wrapper.setAttribute(attrName, String(value));
                        }
                      }
                    }
                  }

                  // Append wrapper to parent and render GXT into wrapper
                  parentElement.appendChild(wrapper);
                  actualRenderTarget = wrapper as unknown as SimpleElement;

                  // Store wrapper reference for component.element access
                  // This uses Ember's view element tracking
                  if (typeof setViewElement === 'function') {
                    setViewElement(component, wrapper);
                  }
                }
              }

              // Begin render pass for backtracking detection
              gxtRenderPass().beginRenderPass();

              // Push root component onto parentView stack before rendering
              if (root && 'layoutName' in root) {
                getGxtRenderer()!.viewUtils.pushParentView(root);
              }
              // Wrap the synchronous template render so that init-phase throws
              // (e.g., `init() { throw ... }` on a classic Ember component) are
              // caught here: clear the partially-rendered DOM (matching classic
              // Glimmer VM behaviour for init failures) and re-throw to
              // `assert.throws` / the host.
              let renderPhaseError: unknown = undefined;
              try {
                (template as any).render(renderContext, actualRenderTarget);
              } catch (err) {
                renderPhaseError = err;
              } finally {
                // Pop from parentView stack after rendering
                if (root && 'layoutName' in root) {
                  getGxtRenderer()!.viewUtils.popParentView();
                }
                // End render pass in the finally block so it's cleaned up even when
                // BREAK or other sentinels propagate (e.g., from expectAssertion).
                gxtRenderPass().endRenderPass();
              }
              if (renderPhaseError !== undefined) {
                // Init-phase failure — DOM is partially populated. Clear it
                // before propagating, matching Glimmer's behaviour.
                (parentElement as unknown as Element).innerHTML = '';
                throw renderPhaseError;
              }
            } else if ('$nodes' in template) {
              // Build-time compiled gxt template with $nodes
              _gxtLib().renderComponent(template as any, parentElement, owner);
            } else {
              // eslint-disable-next-line no-console
              console.warn('GXT template detected but cannot render:', template);
            }

            // Flush queued didInsertElement / didRender hooks now that all DOM
            // has been inserted into the live document by GXT. Errors thrown by
            // these hooks are queued by gxt-backend and re-thrown below.
            gxtRenderPass().flushAfterInsertQueue();

            // Re-throw any lifecycle (didInsertElement / destroy) errors captured
            // during the after-insert flush. Init-phase render errors are no
            // longer queued — they propagate directly from `template.render()`
            // above. The queue at this point only ever contains lifecycle errors,
            // so we MUST NOT clear DOM here — `assertText('hello')` after a
            // didInsertElement throw expects the rendered output to remain.
            try {
              gxtRenderPass().flushRenderErrors();
            } catch (renderError) {
              // Lifecycle error — defer it to the root state so it can be
              // re-thrown OUTSIDE errorLoopTransaction (preserving re-renderability)
              (this as any).__gxtDeferredError = renderError;
            }

            const gxtRoot = root;

            // Capture the component's self tag for reactivity tracking
            // This allows us to detect when Ember's set() changes properties
            // set() calls markObjectAsDirty which dirties the SELF_TAG via tagForObject
            if (gxtRoot && 'layoutName' in gxtRoot) {
              const component = gxtRoot as any;
              const componentTag = tagForObject(component);
              this.gxtComponentTag = componentTag;
              this.gxtLastTagValue = valueForTag(componentTag);
            }

            // GXT's fine-grained reactivity drives all re-renders, so `render`
            // is a no-op from here on (it is still invoked by
            // `_gxtForceEmberRerender` and `renderRoots`). Root tag bookkeeping
            // (`gxtComponentTag` / `gxtLastTagValue`) is maintained by
            // `_gxtForceEmberRerender` / `_gxtUpdateRootTagValues`. Lifecycle
            // errors (destroy, didInsertElement during re-render) are stored on
            // `__gxtDeferredError` and re-thrown by renderRoots outside
            // errorLoopTransaction, so they don't permanently disable re-rendering.
            this.render = errorLoopTransaction(() => {});
          } else {
            // A non-GXT template in GXT mode. The GXT build ships no Glimmer VM
            // render/opcode machinery, so there is deliberately no VM fallback:
            // surface a compile error if there is one, else a clear error rather
            // than silently mis-rendering.
            unwrapTemplate(template);
            throw new Error('[gxt] non-GXT template encountered in GXT mode; no VM fallback');
          }
        } catch (e) {
          // See gxtRenderIncomplete doc on the field declaration.
          this.gxtRenderIncomplete = true;
          throw e;
        } finally {
          // Restore the pre-entry depth (not 0) so nested renders unwind
          // correctly.
          _gxtRenderDepth = depth;
        }
      });
    } else {
      this.render = errorLoopTransaction(() => {
        let layout = unwrapTemplate(template).asLayout();
        const context = getContext();

        let iterator = renderMain(
          context,
          owner,
          self,
          builder(context.env, { element: parentElement, nextSibling: null }),
          layout,
          dynamicScope
        );

        let result = (this.result = iterator.sync());

        // Associate the result with the root state (not the owner) so that
        // destruction cascades through:
        //   Owner → Container → Renderer → RendererState → ClassicRootState → result
        // This ensures the container is still alive when component destructors
        // run (e.g. willDestroy looking up the renderer via injection).
        // Previously, associating with the owner made the result a sibling of
        // the Container, causing the Container to be destroyed first — which
        // broke FastBoot where the container was already dead by the time
        // component teardown tried to do lookups. (See: emberjs/ember.js#20984)
        associateDestroyableChild(this, result);

        this.render = errorLoopTransaction(() => {
          if (isDestroying(result) || isDestroyed(result)) return;

          return result.rerender({
            alwaysRevalidate: false,
          });
        });
      });
    }
  }

  isFor(possibleRoot: unknown): boolean {
    return this.root === possibleRoot;
  }

  destroy() {
    let { result } = this;

    this.destroyed = true;

    this.root = null as any;
    this.result = undefined;
    this.render = undefined as any;

    if (result !== undefined) {
      if (__GXT_MODE__) {
        // GXT teardown: `result` is the minimal gxt result object. Destruction
        // is owned by GXT's own destroyable system, so there is no Glimmer VM
        // transaction to open — and crucially we must NOT read `this.env`,
        // which would force the (purged) VM evaluation context into existence
        // (a 4MB ProgramHeapImpl). See `createContext` (GXT thrower).
        destroyElementSync(result!);
        destroy(result!);
      } else {
        /*
         Handles these scenarios:

         * When roots are removed during standard rendering process, a transaction exists already
           `.begin()` / `.commit()` are not needed.
         * When roots are being destroyed manually (`component.append(); component.destroy() case), no
           transaction exists already.
         * When roots are being destroyed during `Renderer#destroy`, no transaction exists

         */
        inTransaction(this.env, () => {
          destroy(result!);
        });
      }
    }
  }
}

const renderers: BaseRenderer[] = [];

// Re-entrancy guard for `_gxtForceEmberRerender`.
let _gxtForceRerenderInProgress = false;

// Dirty roots recorded by `_gxtUpdateRootTagValues` during a GXT DOM sync,
// consumed (and cleared) by `_gxtForceEmberRerender` in the same sync.
let _gxtDirtyRootsAtSync: any[] | undefined;

// Render depth of `ClassicRootState` renders (e.g. engine-mounting chains);
// renders nested deeper than 20 are skipped with a warning.
let _gxtRenderDepth = 0;

export function _resetRenderers() {
  renderers.length = 0;
}

function register(renderer: BaseRenderer): void {
  assert('Cannot register the same renderer twice', renderers.indexOf(renderer) === -1);
  renderers.push(renderer);
}

function deregister(renderer: BaseRenderer): void {
  let index = renderers.indexOf(renderer);
  assert('Cannot deregister unknown unregistered renderer', index !== -1);
  renderers.splice(index, 1);
}

function loopBegin(): void {
  for (let renderer of renderers) {
    renderer.rerender();
  }
}

interface RenderSettledDeferred {
  promise: Promise<void>;
  resolve: () => void;
}

let renderSettledDeferred: RenderSettledDeferred | null = null;
/*
  Returns a promise which will resolve when rendering has settled. Settled in
  this context is defined as when all of the tags in use are "current" (e.g.
  `renderers.every(r => r._isValid())`). When this is checked at the _end_ of
  the run loop, this essentially guarantees that all rendering is completed.

  @method renderSettled
  @returns {Promise<void>} a promise which fulfills when rendering has settled
*/
export function renderSettled() {
  if (renderSettledDeferred === null) {
    let resolve!: () => void;
    let promise = new Promise<void>((r) => (resolve = r));
    renderSettledDeferred = { promise, resolve };
    // if there is no current runloop, the promise created above will not have
    // a chance to resolve (because its resolved in backburner's "end" event)
    if (!_getCurrentRunLoop()) {
      // ensure a runloop has been kicked off. In GXT mode its end flushes any
      // pending DOM sync before the 'end' listener registered below resolves
      // the deferred, so the promise resolves after the DOM is up to date.
      _backburner.schedule('actions', null, NO_OP);
    }
  }

  return renderSettledDeferred.promise;
}

function resolveRenderPromise() {
  if (renderSettledDeferred !== null) {
    let resolve = renderSettledDeferred.resolve;
    renderSettledDeferred = null;

    _backburner.join(null, resolve);
  }
}

let loops = 0;
function loopEnd() {
  for (let renderer of renderers) {
    if (!renderer.isValid()) {
      if (loops > ENV._RERENDER_LOOP_LIMIT) {
        loops = 0;
        // TODO: do something better
        renderer.destroy();
        throw new Error('infinite rendering invalidation detected');
      }
      loops++;
      return _backburner.join(null, NO_OP);
    }
  }
  loops = 0;
  resolveRenderPromise();
}

// In GXT mode, don't hook into backburner's begin/end events for render
// revalidation. GXT handles rendering via its own reactivity system; pending
// DOM syncs are flushed at the end of the outermost run loop (and explicitly
// by the test helpers).
if (!__GXT_MODE__) {
  _backburner.on('begin', loopBegin);
  _backburner.on('end', loopEnd);
} else {
  // Backburner fires 'end' event listeners BEFORE the onEnd option. Thus
  // we must flush GXT's pending DOM sync here (not rely on runloop.onEnd)
  // so that renderSettled()'s promise resolves AFTER the DOM is up-to-date.
  // Only flush on the outermost runloop end (nextInstance == null) and when
  // not inside runTask (which performs its own explicit sync).
  _backburner.on('end', (_curr: unknown, nextInstance: unknown) => {
    loops = 0;
    const _cpBB = getGxtRenderer()?.compilePipeline;
    if (nextInstance == null && _cpBB?.getPendingSync?.() && !_cpBB?.getRunTaskActive?.()) {
      const syncNow = _cpBB?.syncDomNow;
      if (typeof syncNow === 'function') {
        try {
          syncNow();
        } catch {
          /* errors handled inside sync */
        }
      }
    }
    resolveRenderPromise();
  });
}

// Force re-render all GXT roots whose own tag moved in the current sync
// cycle. gxt-backend calls this (as `compilePipeline.forceEmberRerender`) from
// its DOM sync when GXT's cell tracking misses changes made through Ember's
// set() / notifyPropertyChange, and from the helper-recompute path so formulas
// reading helper cells re-evaluate.
function _gxtForceEmberRerender(): void {
  // Re-entrancy guard: prevent infinite loops when re-rendering triggers
  // cell updates that schedule additional force-rerenders.
  if (_gxtForceRerenderInProgress) return;
  _gxtForceRerenderInProgress = true;
  try {
    const hadPendingSync = Boolean(getGxtRenderer()?.compilePipeline.getHadPendingSync?.());
    const hadNestedObjectChange = Boolean(
      getGxtRenderer()?.compilePipeline.getHadNestedObjectChange?.()
    );
    // Collect roots whose own tag has moved. If `_gxtUpdateRootTagValues`
    // already ran earlier in this sync, it stashed the dirty list in
    // `_gxtDirtyRootsAtSync`; prefer that.
    const dirtyRootsFromSync = _gxtDirtyRootsAtSync;
    const dirtyRoots: any[] = [];
    const allGxtRoots: any[] = [];
    // Roots whose previous render() threw mid-way (gxtRenderIncomplete) —
    // they never wired gxtComponentTag, so the tag comparison below cannot
    // select them. They are retried unconditionally; see the field doc on
    // ClassicRootState.
    const incompleteRoots: any[] = [];
    for (const renderer of renderers) {
      const state = (renderer as any).state as RendererState;
      if (!state) continue;
      const debugRoots = state.debug?.roots;
      if (!debugRoots) continue;
      for (const root of debugRoots) {
        const classicRoot = root as any;
        if (classicRoot.isGxt && (classicRoot.gxtComponentTag || classicRoot.isOutletView)) {
          allGxtRoots.push(classicRoot);
          const currentTagValue = classicRoot.gxtComponentTag
            ? valueForTag(classicRoot.gxtComponentTag)
            : 0;
          if (currentTagValue !== classicRoot.gxtLastTagValue) {
            dirtyRoots.push(classicRoot);
          }
        } else if (classicRoot.gxtRenderIncomplete === true && !classicRoot.destroyed) {
          incompleteRoots.push(classicRoot);
        }
      }
    }
    // Use the pre-sync dirty set (captured before updateRootTagValues cleaned
    // them), falling back to live comparison for call-sites that don't go
    // through the sync pipeline.
    const effectiveDirtyRoots =
      dirtyRootsFromSync && dirtyRootsFromSync.length > 0
        ? dirtyRootsFromSync.filter((r) => allGxtRoots.includes(r))
        : dirtyRoots;
    // Choose which roots to force-render:
    //   - If any root's own tag moved in this sync, render only those (scoped).
    //     This is the common case: a component mutates its own @tracked state.
    //   - Otherwise, fall back to force-render-all only when hadPendingSync AND
    //     hadNestedObjectChange — i.e., a nested-object property change that
    //     doesn't dirty any component's SELF_TAG (e.g., set(m, 'message', ...)).
    //     This preserves cross-root propagation for nested object mutations
    //     while avoiding spurious full re-renders when a @tracked mutation on
    //     a CHILD component doesn't change any root's tag (child is reactive
    //     via its own cell-tracked getters).
    const selectedRoots =
      effectiveDirtyRoots.length > 0
        ? effectiveDirtyRoots
        : hadPendingSync && hadNestedObjectChange
          ? allGxtRoots
          : [];
    // Incomplete roots retry regardless of the tag-based selection (a copy —
    // selectedRoots may alias one of the arrays built above). Gate on
    // hadPendingSync: only an actual classic mutation justifies a retry —
    // without the gate the 16ms interval flush would re-run a still-throwing
    // root every tick and the rethrown error would wedge the suite.
    const rootsToRender =
      incompleteRoots.length > 0 && hadPendingSync
        ? [...new Set([...selectedRoots, ...incompleteRoots])]
        : selectedRoots;
    for (const classicRoot of rootsToRender) {
      // Tag is dirty — force re-render. Increment the render pass ID
      // so the instance pool resets claimed flags and REUSES existing
      // instances instead of creating new ones (which would fire
      // spurious init/render lifecycle hooks).
      _incrementEmberRenderPassId();
      // Render inside `withForceRerender` so gxt-backend knows a forced
      // rerender is in progress. The render error is stashed inside the
      // wrapped body, before the flag is reset.
      const _renderFn = () => {
        try {
          classicRoot.render();
        } catch (renderErr) {
          // Store render error so it can propagate to assert.throws
          if (!classicRoot.__gxtDeferredError) {
            classicRoot.__gxtDeferredError = renderErr;
          }
        }
      };
      const _withForceRerender = getGxtRenderer()?.compilePipeline.withForceRerender;
      if (_withForceRerender) {
        _withForceRerender(_renderFn);
      } else {
        _renderFn();
      }
      // Re-throw deferred errors (from lifecycle hooks like destroy)
      if (classicRoot.__gxtDeferredError) {
        const err = classicRoot.__gxtDeferredError;
        classicRoot.__gxtDeferredError = null;
        if (classicRoot.gxtRenderIncomplete === true) {
          // A recovery retry that threw again: queue the error for the test
          // harness instead of rethrowing — a throw here would abort the
          // force pass mid-loop and wedge subsequent flushes. The flag stays
          // set, so the next classic mutation retries again (classic prod
          // semantics: renders keep being attempted after an error).
          const capture = getGxtRenderer()?.compilePipeline.captureRenderError;
          if (typeof capture === 'function') capture(err);
        } else {
          throw err;
        }
      }
    }
  } finally {
    _gxtForceRerenderInProgress = false;
    getGxtRenderer()?.compilePipeline.setHadPendingSync?.(false);
    getGxtRenderer()?.compilePipeline.setHadNestedObjectChange?.(false);
    _gxtDirtyRootsAtSync = undefined;
  }
}

// Expose `_gxtForceEmberRerender` to gxt-backend.
if (__GXT_MODE__) {
  installCompilePipelinePart({
    forceEmberRerender: _gxtForceEmberRerender,
  });
}

// Check if the given object is a GXT root-component's `root` (i.e., a
// component that owns a top-level renderer state). Used by the GXT re-render
// trigger to distinguish own-SELF_TAG changes (which the cell-based sync
// pipeline handles) from nested-object changes (which need a force-rerender
// fallback).
function _gxtIsRootComponent(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const renderer of renderers) {
    const state = (renderer as any).state as RendererState;
    if (!state) continue;
    const debugRoots = state.debug?.roots;
    if (!debugRoots) continue;
    for (const root of debugRoots) {
      if ((root as any).root === obj) return true;
    }
  }
  return false;
}

// Update gxtLastTagValue on all GXT roots to mark them clean. Called from
// gxt-backend's DOM sync after the cell-based updates, so
// `_gxtForceEmberRerender` sees them as up to date. Also records which roots
// WERE dirty (in `_gxtDirtyRootsAtSync`) so `_gxtForceEmberRerender` can scope
// its rerender to just those roots.
function _gxtUpdateRootTagValues(): void {
  const dirtyRoots: any[] = [];
  for (const renderer of renderers) {
    const state = (renderer as any).state as RendererState;
    if (!state) continue;
    const debugRoots = state.debug?.roots;
    if (!debugRoots) continue;
    for (const root of debugRoots) {
      const classicRoot = root as any;
      if (classicRoot.isGxt && classicRoot.gxtComponentTag) {
        const currentTagValue = valueForTag(classicRoot.gxtComponentTag);
        if (currentTagValue !== classicRoot.gxtLastTagValue) {
          dirtyRoots.push(classicRoot);
        }
        classicRoot.gxtLastTagValue = currentTagValue;
      }
    }
  }
  _gxtDirtyRootsAtSync = dirtyRoots;
}

// Publish the renderer-owned root-component hooks to the gxt-bridge
// `rootComponent` namespace (consumed by gxt-backend/compile.ts).
if (__GXT_MODE__) {
  installRootComponentPart({
    isRootComponent: _gxtIsRootComponent,
    updateRootTagValues: _gxtUpdateRootTagValues,
  });
}

// Render pass ID, incremented before each forced root re-render and by the
// rendering test helpers. Exposed to gxt-backend through `viewUtils`.
let _emberRenderPassId = 0;
function _getEmberRenderPassId(): number {
  return _emberRenderPassId;
}
function _incrementEmberRenderPassId(): void {
  _emberRenderPassId = _emberRenderPassId + 1;
}
if (__GXT_MODE__) {
  installViewUtilsPart({
    getRenderPassId: _getEmberRenderPassId,
    incrementRenderPassId: _incrementEmberRenderPassId,
  });
}

interface ViewRegistry {
  [viewId: string]: unknown;
}

type Resolver = ClassicResolver;

interface RendererData {
  owner: object;
  builder: IBuilder;
  isInteractive: boolean;
  /**
   * Lazily builds the classic-VM evaluation context (ProgramHeapImpl's
   * Int32Array heap + constants pool + environment delegate). Deferred
   * because under the GXT backend the VM never executes, yet every
   * Application/RenderingTestCase boot constructs a renderer — and hot
   * NON-VM paths (`remove()`'s isInteractive check, `rerender()`,
   * `clearAllRoots`) must not force it: eagerly allocating a fresh program
   * heap per test exhausted the cumulative single-page testem realm
   * ("RangeError: Array buffer allocation failed" out of `artifacts()`).
   * `isInteractive` is therefore carried as a plain boolean here instead of
   * being read through `context.env`.
   */
  createContext(): EvaluationContext;
}

class RendererState {
  static create(data: RendererData, renderer: BaseRenderer): RendererState {
    const state = new RendererState(data, renderer);
    associateDestroyableChild(renderer, state);
    return state;
  }

  readonly #data: RendererData;
  #lastRevision = -1;
  #inRenderTransaction = false;
  #destroyed = false;
  #roots: RootState[] = [];
  #removedRoots: RootState[] = [];

  private constructor(data: RendererData, renderer: BaseRenderer) {
    this.#data = data;

    registerDestructor(this, () => {
      this.clearAllRoots(renderer);
    });
  }

  get debug() {
    return {
      roots: this.#roots,
      inRenderTransaction: this.#inRenderTransaction,
      isInteractive: this.isInteractive,
    };
  }

  get roots() {
    return this.#roots;
  }

  get owner(): object {
    return this.#data.owner;
  }

  get builder(): IBuilder {
    return this.#data.builder;
  }

  #context: EvaluationContext | null = null;

  get context(): EvaluationContext {
    return (this.#context ??= this.#data.createContext());
  }

  get env(): Environment {
    return this.context.env;
  }

  get isInteractive(): boolean {
    return this.#data.isInteractive;
  }

  renderRoot(root: RootState, renderer: BaseRenderer): RootState {
    let roots = this.#roots;

    roots.push(root);
    associateDestroyableChild(this, root);

    if (roots.length === 1) {
      register(renderer);
    }

    this.#renderRootsTransaction(renderer);

    return root;
  }

  #renderRootsTransaction(renderer: BaseRenderer): void {
    if (this.#inRenderTransaction) {
      // currently rendering roots, a new root was added and will
      // be processed by the existing _renderRoots invocation
      return;
    }

    // used to prevent calling _renderRoots again (see above)
    // while we are actively rendering roots
    this.#inRenderTransaction = true;

    let completedWithoutError = false;
    try {
      this.renderRoots(renderer);
      completedWithoutError = true;
    } finally {
      if (!completedWithoutError) {
        this.#lastRevision = valueForTag(CURRENT_TAG);
      }
      this.#inRenderTransaction = false;
    }
  }

  renderRoots(renderer: BaseRenderer): void {
    let roots = this.#roots;
    let removedRoots = this.#removedRoots;
    let initialRootsLength: number;
    let _renderIterations = 0;

    do {
      if (__GXT_MODE__) {
        // GXT safety limit against infinite render loops.
        if (++_renderIterations > 20) {
          break;
        }
        // GXT test-harness loop guard (DEBUG only, so it tree-shakes out of
        // the production dist).
        if (DEBUG && typeof (globalThis as any).__gxtOpCheck === 'function') {
          (globalThis as any).__gxtOpCheck();
        }
      }
      initialRootsLength = roots.length;

      const renderRootsPass = () => {
        // ensure that for the first iteration of the loop
        // each root is processed
        for (let i = 0; i < roots.length; i++) {
          let root = roots[i];
          assert('has root', root);

          if (root.destroyed) {
            // add to the list of roots to be removed
            // they will be removed from `this._roots` later
            removedRoots.push(root);

            // skip over roots that have been marked as destroyed
            continue;
          }

          // when processing non-initial reflush loops,
          // do not process more roots than needed
          if (i >= initialRootsLength) {
            continue;
          }

          root.render();

          // In GXT mode, lifecycle errors during re-render (destroy, didInsertElement)
          // are deferred to avoid disabling errorLoopTransaction. Re-throw them here
          // so they propagate to assert.throws() in tests.
          if (__GXT_MODE__ && (root as any).__gxtDeferredError) {
            const err = (root as any).__gxtDeferredError;
            (root as any).__gxtDeferredError = null;
            throw err;
          }
        }

        this.#lastRevision = valueForTag(CURRENT_TAG);
      };

      if (__GXT_MODE__) {
        // GXT roots never enqueue VM-transaction work (no opcodes run), so
        // the env transaction would be empty bookkeeping — but reading
        // `this.context.env` to start it would force the lazy VM evaluation
        // context into existence (a 4MB ProgramHeapImpl Int32Array per
        // renderer; one renderer per test exhausted the V8 ArrayBuffer cage
        // across the cumulative testem run — see `createContext` on
        // RendererData). Run the pass directly instead.
        renderRootsPass();
      } else {
        inTransaction(this.context.env, renderRootsPass);
      }
    } while (roots.length > initialRootsLength);

    // remove any roots that were destroyed during this transaction
    while (removedRoots.length) {
      let root = removedRoots.pop();

      let rootIndex = roots.indexOf(root!);
      roots.splice(rootIndex, 1);
    }

    if (this.#roots.length === 0) {
      deregister(renderer);
    }
  }

  scheduleRevalidate(renderer: BaseRenderer): void {
    _backburner.scheduleOnce('render', this, this.revalidate, renderer);
  }

  isValid(): boolean {
    // In GXT mode, rendering is handled by GXT's reactivity system,
    // not by the Ember renderer's revalidation loop. Always report valid
    // to prevent infinite revalidation loops in loopEnd().
    if (__GXT_MODE__) {
      return true;
    }

    return (
      this.#destroyed || this.#roots.length === 0 || validateTag(CURRENT_TAG, this.#lastRevision)
    );
  }

  revalidate(renderer: BaseRenderer): void {
    // In GXT mode, isValid() returns true to prevent infinite revalidation.
    // But explicit .rerender() calls (which mark the component through
    // `compilePipeline.forceRerender`) still need a sync pass to flush the
    // hooks.
    if (__GXT_MODE__) {
      getGxtRenderer()?.compilePipeline.setPendingSync?.(true);
      return;
    }
    if (this.isValid()) {
      return;
    }
    this.#renderRootsTransaction(renderer);
  }

  clearAllRoots(renderer: BaseRenderer): void {
    let roots = this.#roots;
    for (let root of roots) {
      destroy(root);
    }

    this.#removedRoots.length = 0;
    this.#roots = [];

    // if roots were present before destroying
    // deregister this renderer instance
    if (roots.length) {
      deregister(renderer);
    }
  }
}

type IntoTarget = Cursor | Element | SimpleElement;

/**
 * The returned object from `renderComponent`
 * @public
 * @module @ember/renderer
 */
export interface RenderResult {
  /**
   * Destroys the render tree and removes all rendered content from the element rendered into
   */
  destroy(): void;
}

interface RenderCacheEntry {
  result: RenderResult;
  /**
   * The GlimmerRenderResult from the last render. Used to get positional
   * information (firstNode) when a re-render replaces the content, so
   * that the new content is placed at the same DOM position.
   */
  glimmerResult: GlimmerRenderResult | undefined;
}

/**
 * GXT-mode multi-render bookkeeping. Each `renderComponent` call into a
 * given target produces an independent render entry that tracks its own
 * (firstNode, lastNode) DOM range. Multiple entries can coexist within
 * the same target as siblings; each entry's destroy/re-render operates
 * only on the nodes inside its own range, leaving other entries
 * untouched.
 */
interface GxtRenderEntry {
  /**
   * First and last DOM node belonging to this render. The range is
   * inclusive: every node from firstNode to lastNode (walking nextSibling)
   * is owned by this entry. References update on re-render so the entry's
   * range tracks the live DOM range it occupies.
   */
  firstNode: Node | null;
  lastNode: Node | null;
  destroy: () => void;
  result: RenderResult;
  /**
   * The component definition this entry rendered. Used to dedupe
   * "spurious double-fire" cases where GXT's compiled template invokes
   * the same helper twice for a single source-level mustache (the
   * loose-mode helper-lookup path can do this). When a second
   * renderComponent call into the same target arrives in the SAME
   * runloop with the SAME (component, owner) pair as a prior entry,
   * we treat it as a duplicate of the prior call and reuse the prior
   * result instead of creating a sibling. Genuine sibling renders
   * (e.g. `{{render A 'a' owner}}\n{{render A 'a'}}`) differ in their
   * `owner` arg, so they keep distinct identities.
   */
  component: object;
  ownerObj: object;
  /**
   * The runloop instance that was active when this entry was created.
   * Used to distinguish "sibling renders within the same render pass"
   * (same runloop -> coexist) from "re-render of the same target across
   * runloop boundaries" (different runloop -> destroy prior): synchronous
   * back-to-back renders in one run() are siblings; an outer template
   * re-render that calls renderComponent again replaces.
   */
  runloop: object | null;
}
interface GxtRenderTargetState {
  entries: GxtRenderEntry[];
  /**
   * True once we've performed the initial innerHTML='' clear of the target.
   * Subsequent renders into the same target must NOT clear, so they appear
   * as siblings of prior render entries.
   */
  cleared: boolean;
}
const GXT_RENDER_STATE = new WeakMap<Element, GxtRenderTargetState>();

function intoTarget(into: IntoTarget): Cursor {
  if ('element' in into) {
    return into;
  } else {
    return { element: into as SimpleElement, nextSibling: null };
  }
}

/**
 * GXT-specific renderComponent implementation.
 * Bypasses Glimmer VM bytecode compilation entirely.
 */
function _renderComponentGxt(
  component: object,
  into: IntoTarget,
  owner: object,
  args?: Record<string, unknown>
): RenderResult {
  const globalTemplates = getGxtRenderer()?.registries.componentTemplates;

  // Get the target element
  const targetElement =
    into instanceof Element ? into : 'element' in into ? (into as any).element : into;

  // Multi-render scoping: each renderComponent call into a target gets its
  // own (firstNode, lastNode) DOM range. Multiple renders coexist as
  // siblings (per the renderComponent RFC's "subsequent renders to the
  // same element are prepended" semantics); each entry's destroy /
  // re-render only affects its own range, not the other entries' content.
  // Capture the current runloop instance so the new entry can decide
  // whether prior entries in the same target are "siblings" (same runloop,
  // i.e. same render pass) or "stale" (different runloop, i.e. an outer
  // re-render replacing the prior content).
  const currentRunloop = _getCurrentRunLoop();

  // The render entry is created up-front so the destroy/region helpers can
  // close over a single mutable reference. firstNode/lastNode are filled in
  // after the initial render captures the actual rendered DOM range.
  const entry: GxtRenderEntry = {
    firstNode: null,
    lastNode: null,
    destroy: () => {
      /* set below */
    },
    result: undefined as unknown as RenderResult,
    component,
    ownerObj: owner,
    runloop: currentRunloop,
  };

  let targetState: GxtRenderTargetState | undefined;
  if (targetElement instanceof Element) {
    targetState = GXT_RENDER_STATE.get(targetElement);
    if (!targetState) {
      targetState = { entries: [], cleared: false };
      GXT_RENDER_STATE.set(targetElement, targetState);
    }
    // Spurious-duplicate guard: GXT's compiled template can invoke the
    // same helper-mustache twice in a single render pass when the helper
    // resolves through a loose-mode owner.lookup chain (the `{{a-helper}}`
    // path in `<Loose />` style components). Without this guard, each
    // mustache produces TWO render entries on the target — the first
    // from the helper's first invocation, the second from its spurious
    // second invocation. Dedupe by checking whether a prior entry with
    // the SAME (component, owner) tuple already exists in the same
    // runloop: if so, return the prior entry's result instead of
    // creating a sibling. Distinct siblings (different component or
    // different owner — e.g. the documented `{{render A 'a' owner}}\n
    // {{render A 'a'}}` pattern where the second omits owner) get
    // distinct identities and proceed normally.
    if (currentRunloop !== null && targetState.entries.length > 0) {
      for (const e of targetState.entries) {
        if (e.component === component && e.ownerObj === owner && e.runloop === currentRunloop) {
          // Skip the rest of the render path; we haven't mutated any
          // global state yet at this point in the function.
          return e.result;
        }
      }
    }
    // Replacement vs. sibling decision for prior entries already in this
    // target. A prior entry must be torn down (REPLACED) only when it
    // was created in a DIFFERENT runloop instance — the canonical
    // "renderComponent is eager, tracks with parent" case where an
    // outer @cached getter re-runs after a tag dirty and calls
    // renderComponent again. Plain back-to-back renderComponent calls
    // in the same runloop are kept as concurrent renders (the
    // documented "siblings" pattern of two `{{render A 'a'}}`
    // invocations in one template). Spurious-duplicate calls from the
    // same runloop with the same identity are caught earlier by the
    // dedupe check above.
    if (currentRunloop !== null && targetState.entries.length > 0) {
      const stale: GxtRenderEntry[] = [];
      for (const e of targetState.entries) {
        if (e.runloop !== currentRunloop) stale.push(e);
      }
      for (const e of stale) {
        try {
          e.destroy();
        } catch {
          /* ignore */
        }
      }
    }
    // Initial render into a target that has not yet been claimed by
    // renderComponent: clear any pre-existing contents of the target element.
    if (!targetState.cleared) {
      targetElement.innerHTML = '';
      targetState.cleared = true;
    }
  }

  // Set the ambient owner so the manager system can resolve services
  const prevOwner = getAmbientOwner();
  setAmbientOwner(owner);

  // Ensure GXT context is initialized
  ensureGxtContext();

  let destroyed = false;
  let domCleanupDone = false;
  let classicReactorUnsub: (() => void) | null = null;

  // Remove all DOM nodes belonging to this entry's range (firstNode through
  // lastNode, inclusive). Used for both destroy and the re-render
  // "clear my region" step. After clearing, firstNode/lastNode are reset
  // so the next render can populate them.
  const clearRegion = () => {
    let first = entry.firstNode;
    const last = entry.lastNode;
    if (!first || !last) return;
    while (first) {
      const next: Node | null = first.nextSibling;
      try {
        first.parentNode?.removeChild(first);
      } catch {
        /* ignore */
      }
      if (first === last) break;
      first = next;
    }
    entry.firstNode = null;
    entry.lastNode = null;
  };

  // DOM teardown: removes this render's content range from the target.
  const doDomCleanup = () => {
    if (domCleanupDone) return;
    domCleanupDone = true;
    if (entry.firstNode || entry.lastNode) {
      clearRegion();
    }
    if (targetState) {
      const idx = targetState.entries.indexOf(entry);
      if (idx >= 0) targetState.entries.splice(idx, 1);
      // Once all entries are destroyed, drop the target's bookkeeping so a
      // future renderComponent call on the same element behaves like a
      // fresh first-render (clears any new pre-existing contents).
      if (targetState.entries.length === 0 && targetElement instanceof Element) {
        GXT_RENDER_STATE.delete(targetElement);
      }
    }
  };

  // Synchronous teardown: stop the classic-tag reactor immediately and
  // remove this render's DOM range. Cross-runloop replacement (the eager
  // case) needs sync DOM cleanup so the new render appears alone; the
  // sibling case never reaches doDestroy until the user explicitly calls
  // result.destroy() (e.g. via owner destruction), at which point sync
  // cleanup is also correct.
  const doDestroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (classicReactorUnsub) {
      try {
        classicReactorUnsub();
      } catch {
        /* ignore */
      }
      classicReactorUnsub = null;
    }
    doDomCleanup();
  };
  entry.destroy = doDestroy;

  // Render the template into the target. The "direct" path renders into
  // the target (zero DOM movement, letting GXT's processNodes wire
  // effects against the actual ancestor chain) and is used whenever the
  // parent has no foreign live content from OTHER entries. The
  // "sibling/prepend" path renders into a temporary host of the same
  // tag-name, then moves the resulting children to the FRONT of the
  // actual parent — this gives the documented "subsequent renders are
  // prepended" behavior while preserving live sibling content from prior
  // render entries on the same target.
  const renderIntoRegion = (template: any, ctx: any) => {
    if (!(targetElement instanceof Element)) {
      template.render(ctx, targetElement);
      return;
    }
    const parent: Element = targetElement;
    let hasForeignLiveContent = false;
    if (targetState) {
      for (const e of targetState.entries) {
        if (e === entry) continue;
        if (e.firstNode && e.firstNode.parentNode === parent) {
          hasForeignLiveContent = true;
          break;
        }
      }
    }
    if (!hasForeignLiveContent) {
      template.render(ctx, parent);
      entry.firstNode = parent.firstChild;
      entry.lastNode = parent.lastChild;
      return;
    }
    // Sibling render: render into a temporary host of the same tag-name
    // (so any tag-sensitive child construction inside <table>, <select>,
    // etc. keeps the same parent context), then move the children to the
    // FRONT of the actual parent.
    const host = document.createElement(parent.tagName);
    template.render(ctx, host);
    if (host.firstChild === null) return; // nothing rendered
    const firstCollected: Node | null = host.firstChild;
    const lastCollected: Node | null = host.lastChild;
    const frag = document.createDocumentFragment();
    while (host.firstChild) {
      frag.appendChild(host.firstChild);
    }
    parent.insertBefore(frag, parent.firstChild);
    entry.firstNode = firstCollected;
    entry.lastNode = lastCollected;
  };

  try {
    // Resolve template from COMPONENT_TEMPLATES
    let template = globalTemplates?.get(component);

    // Walk prototype chain if not found directly (for class-based components)
    if (!template && component) {
      let proto = Object.getPrototypeOf(component);
      while (proto && proto !== Function.prototype && proto !== Object.prototype) {
        template = globalTemplates?.get(proto);
        if (template) break;
        proto = Object.getPrototypeOf(proto);
      }
    }

    // If template is a factory function, call it with owner to get actual template
    if (typeof template === 'function' && !template.render) {
      template = template(owner);
    }

    if (!template || !template.render) {
      // No template found — try using the manager system directly
      const managers = (globalThis as any).$_MANAGERS;
      if (managers?.component?.canHandle?.(component)) {
        // Build args with reactive getters so GXT tracks dependencies.
        const gxtArgs: any = {};
        if (args) {
          for (const key of Object.keys(args)) {
            const desc = Object.getOwnPropertyDescriptor(args, key);
            const innerGet = desc?.get;
            if (innerGet) {
              Object.defineProperty(gxtArgs, key, {
                get: function () {
                  touchClassicBridge();
                  return innerGet.call(this);
                },
                enumerable: true,
                configurable: true,
              });
            } else {
              Object.defineProperty(gxtArgs, key, {
                get: () => {
                  touchClassicBridge();
                  return (args as any)[key];
                },
                enumerable: true,
                configurable: true,
              });
            }
          }
        }
        const handleResult = managers.component.handle(component, gxtArgs, null, { owner });
        let nodes: Node | null = null;
        if (typeof handleResult === 'function') {
          nodes = handleResult();
        } else {
          nodes = handleResult;
        }
        if (nodes instanceof Node) {
          if (targetElement instanceof Element) {
            // Prepend (matches the documented "subsequent renders are
            // prepended" semantic) and capture the inserted node as both
            // firstNode and lastNode of this entry so destroy can scope.
            targetElement.insertBefore(nodes, targetElement.firstChild);
            entry.firstNode = nodes;
            entry.lastNode = nodes;
          } else {
            (targetElement as Element).appendChild(nodes);
          }
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn('[renderComponent GXT] No GXT template found for component:', component);
      }

      const result: RenderResult = { destroy: doDestroy };
      entry.result = result;
      if (targetState) {
        targetState.entries.unshift(entry);
      }
      RENDER_CACHE.set(into, { result, glimmerResult: undefined });
      // Register destructor on owner so owner.destroy() cleans up DOM
      try {
        registerDestructor(owner, doDestroy);
      } catch {
        // owner may not be destroyable
      }
      return result;
    }

    // Determine if the component is a class (needs instantiation) or template-only
    const isClass = typeof component === 'function' && component.prototype;
    const isTemplateOnly =
      !isClass ||
      (component as any).__templateOnly === true ||
      getGxtRenderer()?.compilePipeline.isTemplateOnlyDefinition?.(component) === true ||
      getGxtRenderer()?.registries.internalManagers.has(component) === true;

    let instance: any = null;

    if (!isTemplateOnly && isClass) {
      // Instantiate the component class
      const ComponentClass = component as any;

      // Check for custom component manager (from setComponentManager)
      let customManager: any = null;
      const _componentManagers = getGxtRenderer()?.registries.componentManagers;
      let managerFactory: any = _componentManagers?.get(ComponentClass);
      if (!managerFactory) {
        let proto = Object.getPrototypeOf(ComponentClass);
        while (proto && proto !== Object.prototype && proto !== Function.prototype) {
          managerFactory = _componentManagers?.get(proto);
          if (managerFactory) break;
          proto = Object.getPrototypeOf(proto);
        }
      }

      if (typeof managerFactory === 'function') {
        // Use the custom manager to create the instance
        customManager = managerFactory(owner);
        if (customManager && typeof customManager.createComponent === 'function') {
          // Build named args for the custom manager
          const namedArgs: Record<string, any> = {};
          if (args) {
            for (const [key, value] of Object.entries(args)) {
              namedArgs[key] = value;
            }
          }
          const capturedArgs = { named: namedArgs, positional: [] };
          instance = customManager.createComponent(ComponentClass, capturedArgs);
          // Get the rendering context from the manager
          if (typeof customManager.getContext === 'function') {
            const ctx = customManager.getContext(instance);
            if (ctx && ctx !== instance) {
              // Use the manager's context as the render context
              instance = ctx;
            }
          }
        }
      }

      if (!instance) {
        if (typeof ComponentClass.create === 'function') {
          instance = ComponentClass.create(Object.assign({}, args || {}, { owner }));
        } else {
          try {
            instance = new ComponentClass(owner, args || {});
          } catch {
            instance = new ComponentClass();
          }
        }
      }

      // Set args on Glimmer-style components
      if (instance && args) {
        if (!instance.args) {
          instance.args = {};
        }
        // Use Object.keys + defineProperty instead of Object.entries to avoid
        // eagerly evaluating arg getters. Arg getters may have side effects
        // (e.g., tracking steps in tests) and should only be called lazily.
        for (const key of Object.keys(args)) {
          const desc = Object.getOwnPropertyDescriptor(args, key);
          const innerGet = desc?.get;
          if (innerGet) {
            Object.defineProperty(instance.args, key, {
              get: function () {
                touchClassicBridge();
                return innerGet.call(this);
              },
              enumerable: true,
              configurable: true,
            });
          } else {
            Object.defineProperty(instance.args, key, {
              get: () => {
                touchClassicBridge();
                return (args as any)[key];
              },
              enumerable: true,
              configurable: true,
            });
          }
        }
      }
    }

    // Build render context with reactive arg getters
    const renderContext: any = instance || {};
    if (args) {
      // For template-only components, args go directly on the context as getters
      if (!instance) {
        for (const key of Object.keys(args)) {
          Object.defineProperty(renderContext, key, {
            get: () => {
              touchClassicBridge();
              return (args as any)[key];
            },
            enumerable: true,
            configurable: true,
          });
        }
      }
      // Set up args object with reactive getters. Reads touch the
      // classic-validator bridge so any enclosing GXT effect (e.g. the
      // text-node formula for `{{@foo}}`) that reads through this proxy
      // subscribes to the classic-tag bridge cell and re-fires on any
      // classic @glimmer/validator tag mutation. This is the same pattern
      // used by renderLinkToElement in gxt-backend/manager.ts.
      const argsObj: any = {};
      for (const key of Object.keys(args)) {
        Object.defineProperty(argsObj, key, {
          get: () => {
            touchClassicBridge();
            return (args as any)[key];
          },
          enumerable: true,
          configurable: true,
        });
      }
      renderContext.args = argsObj;
    }
    renderContext.owner = owner;

    // Render inside `withRendering` so GXT formulas created during
    // template.render() properly track cell dependencies (e.g., trackedObject
    // cells). It is a depth counter, so nested renders are handled correctly.
    const _pipeline = getGxtRenderer()?.compilePipeline;
    const _isRendering = _pipeline?.isRendering;
    const _withRendering = _pipeline?.withRendering;
    const wasRendering = typeof _isRendering === 'function' ? _isRendering() : false;
    // When renderComponent is called during an existing render pass (e.g.,
    // from a @cached getter during template evaluation), suppress gxtEffect
    // creation for text nodes. These nested renders are "static snapshots" —
    // reactivity is handled by the parent destroying and recreating the render
    // when tracked deps change. Independent text effects would fire out-of-order
    // (before the parent re-renders) and cause double getter evaluations.
    // Top-level renderComponent calls (wasRendering=false) DO need text effects
    // for trackedObject reactivity.
    const _compilePipeline = getGxtRenderer()?.compilePipeline;
    const prevSkipTextEffects = _compilePipeline?.getSkipTextEffects?.() ?? false;
    if (wasRendering) {
      _compilePipeline?.setSkipTextEffects?.(true);
    }
    // Wrap the template render so we can re-invoke it from a classic-tag
    // reactor. This is the same pattern used by renderLinkToElement in
    // gxt-backend/manager.ts: classic @glimmer/validator tag mutations do
    // not reliably re-fire the GXT effects created inside template.render,
    // so we register a side-channel reactor that forces a fresh render
    // whenever any classic tag is dirtied. The reactor is unsubscribed on
    // destroy to avoid leaks across test runs.
    let _rendering = false;
    const _doRender = () => {
      if (destroyed || _rendering) return;
      _rendering = true;
      const prevOwnerLocal = getAmbientOwner();
      setAmbientOwner(owner);
      const _pipelineLocal = getGxtRenderer()?.compilePipeline;
      const prevSkip = _pipelineLocal?.getSkipTextEffects?.() ?? false;
      const wasRenderingLocal = typeof _isRendering === 'function' ? _isRendering() : false;
      if (wasRenderingLocal) _pipelineLocal?.setSkipTextEffects?.(true);
      try {
        // Scoped re-render: clear only the nodes within this entry's
        // range, then render fresh content back into the same range. This
        // preserves sibling renders into the same target.
        if (typeof _withRendering === 'function') {
          _withRendering(() => {
            clearRegion();
            renderIntoRegion(template, renderContext);
          });
        } else {
          clearRegion();
          renderIntoRegion(template, renderContext);
        }
      } finally {
        _pipelineLocal?.setSkipTextEffects?.(prevSkip);
        setAmbientOwner(prevOwnerLocal);
        _rendering = false;
      }
    };

    // Register the classic-tag reactor BEFORE running template.render,
    // but with an `initialized` guard so the callback is a no-op until
    // initial render completes. The purpose of the early registration
    // is to reserve this reactor's slot at the tail of _classicReactors
    // BEFORE any nested renderComponent calls (made during initial
    // template.render) register their own reactors. Set iteration in
    // _fireClassicReactors preserves insertion order, so the parent's
    // reactor fires first on classic-tag dirty — and when the parent's
    // re-render calls renderComponent again on the same target, it
    // destroys the nested render before the nested reactor would have
    // had a chance to emit spurious arg-reads (see the "renderComponent
    // is eager, so it tracks with its parent" strict-mode test).
    //
    // The reactor is per-call: each renderComponent registers its own
    // callback that closes over its own (renderContext, targetElement,
    // destroyed flag). Cleanup is via doDestroy, chained through the owner
    // destructor so owner.destroy() unhooks all reactors.
    //
    // The reactor also self-unsubscribes once the target element has been
    // attached to the document and then stayed detached for a few ticks.
    // Without this, when the caller passes a synthetic owner ({} — the
    // documented default for renderComponent), registerDestructor below
    // silently fails on the plain object, leaving the reactor live across
    // tests; on the next test's classic-tag dirty (e.g. typing in a
    // textarea) the leaked reactor would fire _doRender on the prior
    // test's detached target and clobber shared GXT sync state via
    // syncDomNow. A target that has never been attached (rendering into a
    // detached element that is attached later) keeps _hasBeenConnected
    // false, so we keep firing until it connects. This mirrors the LinkTo
    // path in gxt-backend/manager.ts.
    let reactorInitialized = false;
    let _hasBeenConnected = false;
    let _disconnectedTicks = 0;
    {
      const fireReactor = () => {
        if (destroyed) return;
        try {
          _doRender();
        } catch {
          /* ignore individual reactor errors */
        }
        // After re-render, flush GXT DOM so the new text content is visible.
        try {
          getGxtRenderer()?.compilePipeline.syncDomNow?.();
        } catch {
          /* ignore */
        }
      };
      classicReactorUnsub = registerClassicReactor(() => {
        if (destroyed || !reactorInitialized) return;
        if (targetElement instanceof Element) {
          if (targetElement.isConnected) {
            _hasBeenConnected = true;
            _disconnectedTicks = 0;
          } else if (_hasBeenConnected) {
            // Was connected, now detached: count grace ticks then bail.
            _disconnectedTicks++;
            if (_disconnectedTicks > 4) {
              try {
                classicReactorUnsub?.();
              } catch {
                /* ignore */
              }
              classicReactorUnsub = null;
              destroyed = true;
            }
            // Skip rendering into a detached target either way.
            return;
          }
          // else: never connected — fall through (legitimate
          // detached-element use case).
        }
        fireReactor();
      }, '_renderComponentGxt');
    }

    try {
      // Render the template into the target (initial render)
      if (wasRendering) {
        _compilePipeline?.setSkipTextEffects?.(true);
      }
      if (typeof _withRendering === 'function') {
        _withRendering(() => {
          renderIntoRegion(template, renderContext);
        });
      } else {
        renderIntoRegion(template, renderContext);
      }
    } finally {
      _compilePipeline?.setSkipTextEffects?.(prevSkipTextEffects);
      // Arm the reactor: from now on, classic-tag dirties will trigger
      // _doRender. This is done in `finally` so that any tag dirties
      // that happened DURING initial render (e.g. from component init
      // writing @tracked fields) do not retroactively trigger a
      // spurious re-render after the render completes.
      reactorInitialized = true;
    }

    // Flush queued didInsertElement / didRender hooks
    try {
      gxtRenderPass().flushAfterInsertQueue();
    } catch {
      // Ignore flush errors in renderComponent context
    }
    gxtRenderPass().flushRenderErrors();
  } finally {
    setAmbientOwner(prevOwner);
  }

  const result: RenderResult = { destroy: doDestroy };
  entry.result = result;
  if (targetState) {
    targetState.entries.unshift(entry);
  }
  RENDER_CACHE.set(into, { result, glimmerResult: undefined });

  // Register destructor on owner so that destroying the owner cleans up the DOM
  try {
    registerDestructor(owner, doDestroy);
  } catch {
    // owner may not be destroyable
  }

  return result;
}

/**
 * Render a component into a DOM element.
 *
 * @method renderComponent
 * @static
 * @for @ember/renderer
 * @param {Object} component The component to render.
 * @param {Object} options
 * @param {Element} options.into Where to render the component in to.
 * @param {Object} [options.owner] Optionally specify the owner to use. This will be used for injections, and overall cleanup.
 * @param {Object} [options.env] Optional renderer configuration
 * @param {Object} [options.args] Optionally pass args in to the component. These may be reactive as long as it is an object or object-like
 * @public
 */
export function renderComponent(
  /**
   * The component definition to render.
   *
   * Any component that has had its manager registered is valid.
   * For the component-types that ship with ember, manager registration
   * does not need to be worried about.
   */
  component: object,
  {
    owner = {},
    env,
    into,
    args,
  }: {
    /**
     * The element to render the component in to.
     */
    into: IntoTarget;

    /**
     * Optional owner. Defaults to `{}`, can be any object, but will need to implement the [Owner](https://api.emberjs.com/ember/release/classes/Owner) API for components within this render tree to access services.
     */
    owner?: object;
    /**
     * Optionally configure the rendering environment
     */
    env?: {
      /**
       * When false, modifiers will not run.
       */
      isInteractive?: boolean;
      /**
       * All other options are forwarded to the underlying renderer.
       * (its API is currently private and out of scope for this RFC,
       *  so passing additional things here is also considered private API)
       */
      [rendererOption: string]: unknown;
    };

    /**
     * These args get passed to the rendered component
     *
     * If your args are reactive, re-rendering will happen automatically.
     *
     */
    args?: Record<string, unknown>;
  }
): RenderResult {
  // GXT escape hatch: bypass Glimmer VM entirely for GXT mode.
  // This avoids bytecode compilation which crashes with GXT templates.
  if (__GXT_MODE__) {
    return _renderComponentGxt(component, into, owner, args);
  }

  /**
   * SAFETY: we should figure out what we need out of a `document` and narrow the API.
   *         this exercise should also end up beginning to define what we need for CLI rendering (or to other outputs)
   */
  let document =
    env && 'document' in env
      ? (env?.['document'] as SimpleDocument | Document)
      : globalThis.document;

  // Reuse renderer per owner to avoid creating multiple EvaluationContexts
  // which can cause tracking frame conflicts
  let renderer = RENDERER_CACHE.get(owner);
  if (!renderer) {
    renderer = BaseRenderer.strict(owner, document, {
      ...env,
      isInteractive: env?.isInteractive ?? true,
      hasDOM: env && 'hasDOM' in env ? Boolean(env?.['hasDOM']) : true,
    });
    RENDERER_CACHE.set(owner, renderer);
  }

  /**
   * Replace all contents, if we've rendered multiple times.
   *
   * https://github.com/emberjs/rfcs/pull/1099/files#diff-2b962105b9083ca84579cdc957f27f49407440f3c5078083fa369ec18cc46da8R365
   *
   * We could later add an option to not do this behavior
   *
   * NOTE: destruction is async
   */
  let existing = RENDER_CACHE.get(into);
  existing?.result.destroy();
  /**
   * We can only replace the inner HTML the first time.
   * Because destruction is async, it won't be safe to
   * do this again, and we'll have to rely on the above destroy.
   */
  if (!existing && into instanceof Element) {
    into.innerHTML = '';
  }

  /**
   * If there's an existing render result with valid bounds, use its
   * firstNode as the nextSibling so that new content is inserted at
   * the same DOM position. This ensures stable ordering when multiple
   * renderComponent calls target the same element and one is re-invoked
   * (e.g., due to tracked dependency changes).
   *
   * The old content's DOM nodes are still present (destruction is async),
   * so firstNode() is a valid position reference. The new content is placed
   * BEFORE the old content. When the old content is eventually destroyed
   * (async clear of bounds), the new content remains in the correct position.
   */
  let renderTarget: IntoTarget = into;
  if (existing?.glimmerResult) {
    let parentElement =
      into instanceof Element ? (into as unknown as SimpleElement) : (into as Cursor).element;
    let firstNode = existing.glimmerResult.firstNode();
    renderTarget = { element: parentElement, nextSibling: firstNode };
  }

  let innerResult = renderer.render(component, { into: renderTarget, args }).result;

  if (innerResult) {
    associateDestroyableChild(owner, innerResult);
  }

  let result: RenderResult = {
    destroy() {
      if (innerResult) {
        destroy(innerResult);
      }
    },
  };

  RENDER_CACHE.set(into, { result, glimmerResult: innerResult });

  return result;
}

const RENDER_CACHE = new WeakMap<IntoTarget, RenderCacheEntry>();
const RENDERER_CACHE = new WeakMap<object, BaseRenderer>();

// Default element builder for the classic VM render loop. Under __GXT_MODE__
// the Glimmer VM element-builder is never invoked (renderMain /
// glimmerRenderComponent are gated off and the GXT render path never touches a
// VM builder), so resolving the literal `clientBuilder` here would needlessly
// retain the VM element-builder module. Gate it behind `!__GXT_MODE__` so the
// `clientBuilder` reference is statically dead in the GXT dist; the GXT branch
// is a thrower (fail loud, no VM fallback) that is never reached at runtime.
const defaultClientBuilder: IBuilder = __GXT_MODE__
  ? (((): never => {
      throw new Error('[gxt] Glimmer VM element builder requested in GXT mode; no VM fallback.');
    }) as unknown as IBuilder)
  : clientBuilder;

class BaseRenderer {
  static strict(
    owner: object,
    document: SimpleDocument | Document,
    options: { isInteractive: boolean; hasDOM?: boolean }
  ) {
    return new BaseRenderer(
      owner,
      { hasDOM: hasDOM, ...options },
      document as SimpleDocument,
      new ResolverImpl(),
      defaultClientBuilder
    );
  }

  readonly state: RendererState;

  constructor(
    owner: object,
    envOptions: { isInteractive: boolean; hasDOM: boolean },
    document: SimpleDocument,
    resolver: Resolver,
    builder: IBuilder
  ) {
    // The VM evaluation context is handed to RendererState as a LAZY thunk —
    // see the `createContext` doc on `RendererData` for why (per-test program
    // heap allocations exhausted the cumulative GXT testem realm; non-VM
    // paths like `remove()`/`rerender()` must stay allocation-free).
    //
    // Under __GXT_MODE__ the entire Glimmer VM evaluation context (artifacts /
    // ProgramHeapImpl / runtimeOptions / EvaluationContextImpl / RuntimeOpImpl)
    // is dead: the GXT backend never executes opcodes. Defining the real thunk
    // only in the classic branch makes every one of those VM bindings
    // statically unreferenced in the GXT dist, so the ~166KB opcode-eval core
    // tree-shakes out. Every GXT-reachable force-site (ClassicRootState.destroy
    // teardown, `_context`, `debugRenderTree`) is gated NOT to call this; the
    // GXT thrower below fails loud if a classic-only path ever forces it,
    // honoring the "no VM fallback in GXT mode" contract.
    let createContext: () => EvaluationContext;
    if (__GXT_MODE__) {
      createContext = (() => {
        throw new Error(
          '[gxt] Glimmer VM evaluation context requested in GXT mode; the VM ' +
            'render/opcode pipeline is not part of the GXT build (no fallback).'
        );
      }) as () => EvaluationContext;
    } else {
      createContext = (): EvaluationContext => {
        let sharedArtifacts = artifacts();

        /**
         * SAFETY: are there consequences for being looser with *this* owner?
         *         the public API for `owner` is kinda `Partial<InternalOwner>`
         *         aka: implement only what you need.
         *         But for actual ember apps, you *need* to implement everything
         *         an app needs (which will actually change and become less over time)
         */
        let env = new EmberEnvironmentDelegate(owner as InternalOwner, envOptions.isInteractive);
        let options = runtimeOptions({ document }, env, sharedArtifacts, resolver);
        return new EvaluationContextImpl(
          sharedArtifacts,
          (heap) => new RuntimeOpImpl(heap),
          options
        );
      };
    }

    this.state = RendererState.create(
      {
        owner,
        builder,
        isInteractive: envOptions.isInteractive,
        createContext,
      },
      this
    );

    if (!__GXT_MODE__) {
      // Classic builds keep the EAGER constructor-time VM context exactly as
      // before (the `__GXT_MODE__` literal is inlined by both build
      // pipelines, so this touch is dead-branched only in GXT dists).
      void this.state.context;
    }
  }

  get debugRenderTree(): DebugRenderTree {
    if (__GXT_MODE__) {
      // The classic debugRenderTree lives on the Glimmer VM environment, which
      // is not built under the GXT backend; reading `this.state.env` here would
      // force the VM evaluation context. Return a minimal DebugRenderTree whose
      // `.capture()` delegates to gxt's `captureRenderTree` instead (consumed by
      // `@ember/debug`'s `captureRenderTree(owner)`, e.g. for Ember Inspector).
      return getGxtDebugRenderTree();
    }

    let { debugRenderTree } = this.state.env;

    assert(
      'Attempted to access the DebugRenderTree, but it did not exist. Is the Ember Inspector open?',
      debugRenderTree
    );

    return debugRenderTree;
  }

  isValid(): boolean {
    return this.state.isValid();
  }

  destroy() {
    destroy(this);
  }

  render(
    component: object,
    options: { into: IntoTarget; args?: Record<string, unknown> }
  ): RootState {
    const root = new ComponentRootState(this.state, component, {
      args: options.args,
      into: intoTarget(options.into),
    });
    return this.state.renderRoot(root, this);
  }

  rerender(): void {
    this.state.scheduleRevalidate(this);
  }

  // render(component: Component, options: { into: Cursor; args?: Record<string, unknown> }): void {
  //   this.state.renderRoot(component);
  // }
}

export class Renderer extends BaseRenderer {
  static strict(
    owner: object,
    document: SimpleDocument | Document,
    options: { isInteractive: boolean; hasDOM?: boolean }
  ): BaseRenderer {
    return new BaseRenderer(
      owner,
      { hasDOM: hasDOM, ...options },
      document as SimpleDocument,
      new ResolverImpl(),
      defaultClientBuilder
    );
  }

  private _rootTemplate: Template;
  private _viewRegistry: ViewRegistry;

  static create(props: { _viewRegistry: any }): Renderer {
    let { _viewRegistry } = props;
    let owner = getOwner(props);
    assert('Renderer is unexpectedly missing an owner', owner);
    let document = owner.lookup('service:-document') as SimpleDocument;
    let env = owner.lookup('-environment:main') as {
      isInteractive: boolean;
      hasDOM: boolean;
    };
    let rootTemplate = owner.lookup(P`template:-root`) as TemplateFactory;
    let builder = owner.lookup('service:-dom-builder') as IBuilder;
    return new this(owner, document, env, rootTemplate, _viewRegistry, builder);
  }

  constructor(
    owner: InternalOwner,
    document: SimpleDocument,
    env: { isInteractive: boolean; hasDOM: boolean },
    rootTemplate: TemplateFactory,
    viewRegistry: ViewRegistry,
    builder = defaultClientBuilder,
    resolver = new ResolverImpl()
  ) {
    super(owner, env, document, resolver, builder);
    this._rootTemplate = rootTemplate(owner);
    this._viewRegistry = viewRegistry || owner.lookup('-view-registry:main');
  }

  // renderer HOOKS

  appendOutletView(view: OutletView, target: SimpleElement): void {
    // Debug: log that appendOutletView was called

    // TODO: This bypasses the {{outlet}} syntax so logically duplicates
    // some of the set up code. Since this is all internal (or is it?),
    // we can refactor this to do something more direct/less convoluted
    // and with less setup, but get it working first
    let outlet = createRootOutlet(view);
    let { name, /* controller, */ template } = view.state;

    let named = dict<Reference>();

    named['Component'] = createConstRef(
      makeRouteTemplate(view.owner, name, template as Template),
      '@Component'
    );

    // TODO: is this guaranteed to be undefined? It seems to be the
    // case in the `OutletView` class. Investigate how much that class
    // exists as an internal implementation detail only, or if it was
    // used outside of core. As far as I can tell, test-helpers uses
    // it but only for `setOutletState`.
    // named['controller'] = createConstRef(controller, '@controller');
    // Update: at least according to the debug render tree tests, we
    // appear to always expect this to be undefined. Not a definitive
    // source by any means, but is useful evidence
    named['controller'] = UNDEFINED_REFERENCE;
    named['model'] = UNDEFINED_REFERENCE;

    // appendOutletView is on the GXT root-outlet append path, so under
    // __GXT_MODE__ use a VM-free equivalent of
    // `createCapturedArgs(named, EMPTY_POSITIONAL)` (which is just
    // `{ named, positional }`), keeping the renderer chunk free of
    // `@glimmer/runtime/lib/vm/arguments`.
    let args = __GXT_MODE__
      ? ({ named, positional: EMPTY_POSITIONAL_GXT } as unknown as ReturnType<
          typeof createCapturedArgs
        >)
      : createCapturedArgs(named, EMPTY_POSITIONAL);

    this._appendDefinition(
      view,
      curry(0 as CurriedComponent, outlet, view.owner, args, true),
      target
    );
  }

  appendTo(view: ClassicComponent, target: SimpleElement): void {
    // Debug: log that appendTo was called

    // In GXT mode ClassicRootState renders the (GXT) root template itself;
    // see `templateIsGxt`.
    let definition = new RootComponentDefinition(view);
    this._appendDefinition(
      view,
      curry(0 as CurriedComponent, definition, this.state.owner, null, true),
      target
    );
  }

  _appendDefinition(
    root: OutletView | ClassicComponent,
    definition: CurriedValue,
    target: SimpleElement
  ): void {
    let self = createConstRef(definition, 'this');
    let dynamicScope = new DynamicScope(null, UNDEFINED_REFERENCE);
    let rootState = new ClassicRootState(
      root,
      () => this.state.context,
      this.state.owner,
      this._rootTemplate,
      self,
      target,
      dynamicScope,
      this.state.builder
    );
    this.state.renderRoot(rootState, this);
  }

  cleanupRootFor(component: ClassicComponent): void {
    // no need to cleanup roots if we have already been destroyed
    if (isDestroyed(this)) {
      return;
    }

    let roots = this.state.roots;

    // traverse in reverse so we can remove items
    // without mucking up the index
    let i = roots.length;
    while (i--) {
      let root = roots[i];
      assert('has root', root);
      if (root.type === 'classic' && root.isFor(component)) {
        root.destroy();
        roots.splice(i, 1);
      }
    }
  }

  remove(view: ClassicComponent): void {
    view._transitionTo('destroying');

    this.cleanupRootFor(view);

    if (this.state.isInteractive) {
      view.trigger('didDestroyElement');
    }
  }

  get _roots() {
    return this.state.debug.roots;
  }

  get _inRenderTransaction() {
    return this.state.debug.inRenderTransaction;
  }

  get _isInteractive() {
    return this.state.debug.isInteractive;
  }

  get _context() {
    // In GXT mode there is no real EvaluationContext (`this.state.context`
    // would throw). Callers such as the runtime-resolver cache tests only read
    // `_context.constants.{component,helper,modifier}DefinitionCount`, so
    // serve those counts from the GXT resolver-cache tracker instead.
    if (__GXT_MODE__) {
      const counters = getGxtRenderer()?.compilePipeline.getResolverCacheCounters?.();
      return {
        constants: {
          componentDefinitionCount: counters?.componentDefinitionCount || 0,
          helperDefinitionCount: counters?.helperDefinitionCount || 0,
          modifierDefinitionCount: counters?.modifierDefinitionCount || 0,
        },
      } as unknown as EvaluationContext;
    }
    return this.state.context;
  }

  register(view: any): void {
    let id = getViewId(view);
    // In GXT mode, view registration can conflict during a forced rerender
    // or when views aren't fully cleaned up between test runs. Silently
    // overwrite the existing entry instead of asserting.
    if (__GXT_MODE__) {
      this._viewRegistry[id] = view;
      return;
    }
    assert(
      'Attempted to register a view with an id already in use: ' + id,
      !this._viewRegistry[id]
    );
    this._viewRegistry[id] = view;
  }

  unregister(view: any): void {
    delete this._viewRegistry[getViewId(view)];
  }

  getElement(component: View): Nullable<Element> {
    if (this._isInteractive) {
      return getViewElement(component);
    } else {
      throw new Error(
        'Accessing `this.element` is not allowed in non-interactive environments (such as FastBoot).'
      );
    }
  }

  getBounds(component: View): {
    parentElement: SimpleElement;
    firstNode: SimpleNode;
    lastNode: SimpleNode;
  } {
    let bounds: Bounds | null = component[BOUNDS];

    // In GXT mode, BOUNDS may not be set on the component. Fall back to
    // synthesizing bounds from the component's element (wrapper or tagless).
    if (!bounds && __GXT_MODE__) {
      const element = getViewElement(component);
      if (element) {
        // Regular component with a wrapper element
        return {
          parentElement: element.parentNode as unknown as SimpleElement,
          firstNode: element as unknown as SimpleNode,
          lastNode: element as unknown as SimpleNode,
        };
      }
      // Tagless component — look for the __gxtBounds marker
      const gxtBounds = (component as any).__gxtBounds;
      if (gxtBounds) {
        return {
          parentElement: gxtBounds.parentElement as unknown as SimpleElement,
          firstNode: gxtBounds.firstNode as unknown as SimpleNode,
          lastNode: gxtBounds.lastNode as unknown as SimpleNode,
        };
      }
    }

    assert('object passed to getBounds must have the BOUNDS symbol as a property', bounds);

    let parentElement = bounds.parentElement();
    let firstNode = bounds.firstNode();
    let lastNode = bounds.lastNode();

    return { parentElement, firstNode, lastNode };
  }
}
