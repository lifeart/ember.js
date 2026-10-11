// gxt NATIVE layer — the host manager tables gxt consults through
// `registerHostManagers` (design §2.3). Inc 4a: the COMPONENT slot. Helper and
// modifier slots are Inc 5.
//
// How gxt renders a component: `$_c(Def, args, ctx)` → `_component` asks
// `$_MANAGERS.component.canHandle(Def)`; when true, `handle(Def, args, fw, ctx)`
// returns what gxt then CONSTRUCTS (`new X(args, fw)`): either a gxt template
// function (rendered directly) or a constructor-shaped factory whose result has
// a `[$template]`. gxt adds that instance to its render tree, runs
// `instance[$template](args)` with `this` = instance, and later tears the tree
// down, running the destructors registered on each node. So the manager here
// only adapts Ember's component-manager protocol to that shape:
//
//   - canHandle: definitions with a component manager (prototype walk — the
//     @glimmer/component class, any `setComponentManager` class) and
//     `templateOnly()` definitions. NOT gxt template functions (`.gjs`
//     template-only components): gxt renders those natively, fewest hops.
//   - handle (custom manager, e.g. @glimmer/component): a factory that, per
//     INVOCATION, creates the component through the per-owner manager delegate
//     (`createComponent(Def, {named: args, positional: []})` — `args` is gxt's
//     lazy, autotracked args object, so `this.args.x` subscribes the reading
//     formula), gives the template context a gxt tree id, sets its template
//     (own registration > class-body `<template>` > inherited registration >
//     empty), and registers a gxt destructor that calls `destroyComponent`
//     (Glimmer manager: willDestroy + Ember `destroy()` + isDestroying /
//     isDestroyed on the runloop) when gxt removes the node.
//   - handle (templateOnly definition): its registered template function.
//   - Ember INTERNAL component managers (LinkTo's InternalComponent) are Inc 6.
//
// The owner comes from the gxt render context (`OWNER`, provided on every
// render root by native/renderer.ts) — the nearest provider up the tree.
import { DEBUG } from '@glimmer/env';
import {
  $_GET_ARGS,
  $_fin,
  $PROPS_SYMBOL,
  $SLOTS_SYMBOL,
  $template,
  cId,
  COMPONENT_ID_PROPERTY,
  getContext,
  getCurried,
  isTemplateFn,
  registerDestructor as gxtRegisterDestructor,
  resolveCurried,
} from '@lifeart/gxt';
import { argsProxyFor, unwrapArg } from './args';
import {
  CustomComponentManager,
  FROM_CAPABILITIES,
  getComponentTemplate,
  getInternalComponentManager,
  getOwnComponentTemplate,
} from './manager-api';
import { notImplemented } from './not-implemented';
import { TemplateOnlyComponentDefinition } from './template-only';
import { templateFor, type GxtTemplate } from './template-factory';

/** gxt context key for the Ember owner of a render tree (provided on roots). */
export const OWNER: unique symbol = Symbol('ember-native-owner');

interface ComponentDelegate {
  capabilities: { destructor?: boolean };
  createComponent(
    definition: object,
    args: { named: object; positional: readonly unknown[] }
  ): object;
  getContext(component: object): object;
  destroyComponent?(component: object): void;
}

type ComponentNode = Record<PropertyKey, unknown> & object;

const EMPTY_POSITIONAL: unknown[] = Object.freeze([]) as unknown as unknown[];

// Glimmer's CustomComponentManager.getDelegateFor: one delegate per (manager, owner).
const DELEGATES = new WeakMap<CustomComponentManager, WeakMap<object, ComponentDelegate>>();

function delegateFor(manager: CustomComponentManager, owner: object): ComponentDelegate {
  let byOwner = DELEGATES.get(manager);
  if (byOwner === undefined) {
    byOwner = new WeakMap();
    DELEGATES.set(manager, byOwner);
  }
  let delegate = byOwner.get(owner);
  if (delegate === undefined) {
    delegate = manager.factory(owner) as ComponentDelegate;
    if (DEBUG && !FROM_CAPABILITIES!.has(delegate.capabilities)) {
      throw new Error(
        `Custom component managers must have a \`capabilities\` property that is the result of calling the \`capabilities('3.13')\` (imported via \`import { capabilities } from '@ember/component';\`). Received: \`${JSON.stringify(delegate.capabilities)}\` for: \`${String(delegate)}\``
      );
    }
    byOwner.set(owner, delegate);
  }
  return delegate;
}

// The owner of the render tree `ctx` belongs to (nearest OWNER provider).
function ownerFor(ctx: object): object {
  const owner = getContext<object>(ctx as never, OWNER, false);
  if (owner === null || owner === undefined) {
    throw new Error(
      'native component manager: no Ember owner in this render tree. Render through `renderComponent` from `@ember/renderer` (or an Ember application), which provides one.'
    );
  }
  return owner;
}

// A component without any template renders nothing (Glimmer parity).
function EMPTY_TEMPLATE(this: object): unknown {
  // eslint-disable-next-line prefer-rest-params
  $_GET_ARGS(this as never, arguments);
  return $_fin([], this as never);
}

function resolveTemplate(value: unknown, owner: object, definition: object): GxtTemplate {
  const template = templateFor(value, owner);
  if (template === undefined) {
    throw new Error(
      `native component manager: the template registered for \`${nameOfDefinition(definition)}\` is not a gxt template (compile it with the gxt compiler).`
    );
  }
  return template;
}

// ---------------------------------------------------------------- names
// Template context (gxt node) → its Ember component definition, and template
// function → the templateOnly() definition it renders (resolveComponentName).
const DEFINITION_OF_NODE = new WeakMap<object, object>();
const DEFINITION_OF_TEMPLATE = new WeakMap<object, object>();
// Registry / route names (Inc 4b route templates, Inc 8 resolver lookups).
const REGISTERED_NAMES = new WeakMap<object, string>();
// Per rendered NODE (wins over the definition's name): the route name of a
// route template rendered by an outlet (one template function can serve several
// routes — `templateName`, the shared default `{{outlet}}` template), `main`
// for an outlet.
const NODE_NAMES = new WeakMap<object, string>();

/**
 * Give a component definition (class, templateOnly() definition or gxt
 * template function) the name the Inspector should show — e.g. the route name
 * of a route template or the resolver name of a loose-mode component.
 */
export function nameComponent(definition: object, name: string): void {
  REGISTERED_NAMES.set(definition, name);
}

/** Name one rendered component node for the Inspector (native/outlet.ts). */
export function nameNode(node: object, name: string): void {
  NODE_NAMES.set(node, name);
}

function nameOfDefinition(definition: object): string {
  const registered = REGISTERED_NAMES.get(definition);
  if (registered !== undefined) return registered;
  if (definition instanceof TemplateOnlyComponentDefinition) {
    return definition.name !== '(unknown template-only component)'
      ? definition.name
      : definition.moduleName;
  }
  if (typeof definition === 'function' && definition.name) return definition.name;
  return String(definition);
}

/**
 * gxt `resolveComponentName` host hook (captureRenderTree / Inspector): the
 * Ember definition's name for component nodes this layer created and for gxt
 * template-function components; `undefined` for gxt-internal nodes (if / each /
 * slots / roots), so gxt's keyword naming still applies to them.
 */
export function resolveComponentName(node: object): string | undefined {
  const nodeName = NODE_NAMES.get(node);
  if (nodeName !== undefined) return nodeName;
  const definition = DEFINITION_OF_NODE.get(node);
  if (definition !== undefined) return nameOfDefinition(definition);
  const ctor = (node as { constructor?: unknown }).constructor;
  if (isTemplateFn(ctor)) {
    const templateOnly = DEFINITION_OF_TEMPLATE.get(ctor as object);
    if (templateOnly !== undefined) return nameOfDefinition(templateOnly);
    return REGISTERED_NAMES.get(ctor as object) ?? ((ctor as { name?: string }).name || undefined);
  }
  return undefined;
}

// ---------------------------------------------------------------- curried
// A curried component (`(component X a=1)`, gxt G9): Glimmer argument rules —
// the curried layers' named arguments (inner → outer, later wins) under the
// invocation's own arguments (which win); the invocation's blocks and
// forwarded attributes. Values stay lazy (literal-or-thunk / gxt arg getters).
function mergeCurriedArgs(
  layers: ReadonlyArray<Readonly<Record<string, unknown>>>,
  args: Record<PropertyKey, unknown>
): Record<PropertyKey, unknown> {
  const merged: Record<PropertyKey, unknown> = {};
  Object.defineProperty(merged, $SLOTS_SYMBOL, { value: args[$SLOTS_SYMBOL] });
  Object.defineProperty(merged, $PROPS_SYMBOL, {
    value: args[$PROPS_SYMBOL],
    configurable: true,
    writable: true,
  });
  for (const layer of layers) {
    for (const key of Object.keys(layer)) {
      Object.defineProperty(merged, key, {
        get: () => unwrapArg(layer[key]),
        enumerable: true,
        configurable: true,
      });
    }
  }
  for (const key of Object.keys(args)) {
    Object.defineProperty(merged, key, {
      get: () => args[key],
      enumerable: true,
      configurable: true,
    });
  }
  return merged;
}

function handleCurried(curried: object, args: object, fw: unknown, ctx: object): unknown {
  const { definition, positional, named } = resolveCurried(curried);
  if (typeof definition === 'string') {
    return notImplemented(`native component lookup by name ("${definition}", loose mode)`, 8);
  }
  const merged = mergeCurriedArgs(named, args as Record<PropertyKey, unknown>);
  if (definition === null || definition === undefined) return EMPTY_TEMPLATE;
  if (canHandle(definition)) {
    const resolved = handle(definition as object, merged, fw, ctx, positional);
    // A manager factory closes over `merged`; a template function is
    // constructed by gxt with the INVOCATION args — hand it the merged ones.
    return isTemplateFn(resolved) || resolved === EMPTY_TEMPLATE
      ? curriedTemplate(resolved as GxtTemplate, merged)
      : resolved;
  }
  // a gxt template function (template-only `.gjs` component)
  return curriedTemplate(definition as GxtTemplate, merged);
}

function curriedTemplate(template: GxtTemplate, merged: object): unknown {
  return function CurriedTemplate(_args: unknown, fw: unknown): object {
    return new (template as unknown as new (a: unknown, f: unknown) => object)(merged, fw);
  };
}

// ---------------------------------------------------------------- component
function canHandle(definition: unknown): boolean {
  if (definition === null || definition === undefined) return false;
  const type = typeof definition;
  if (type !== 'object' && type !== 'function') return false;
  if (definition instanceof TemplateOnlyComponentDefinition) return true;
  if (getCurried(definition) !== undefined) return true;
  if (isTemplateFn(definition)) return false;
  return getInternalComponentManager(definition as object) !== undefined;
}

function handle(
  definition: object,
  args: object,
  fw: unknown,
  ctx: object,
  positional: readonly unknown[] = EMPTY_POSITIONAL
): unknown {
  if (getCurried(definition) !== undefined) return handleCurried(definition, args, fw, ctx);
  const owner = ownerFor(ctx);

  if (definition instanceof TemplateOnlyComponentDefinition) {
    const registered = getComponentTemplate(definition);
    const template =
      registered === undefined ? EMPTY_TEMPLATE : resolveTemplate(registered, owner, definition);
    DEFINITION_OF_TEMPLATE.set(template, definition);
    return template;
  }

  const manager = getInternalComponentManager(definition);
  if (!(manager instanceof CustomComponentManager)) {
    // Ember's internal component manager (InternalComponent: LinkTo).
    return notImplemented(
      `native internal component manager (\`${nameOfDefinition(definition)}\`)`,
      6
    );
  }
  const delegate = delegateFor(manager, owner);
  const ownTemplate = getOwnComponentTemplate(definition);
  const inheritedTemplate =
    ownTemplate === undefined ? getComponentTemplate(definition) : undefined;

  // gxt constructs this per INVOCATION (`new NativeComponent(args, fw)`): every
  // invocation creates its own component through the manager.
  return function NativeComponent(): object {
    const component = delegate.createComponent(definition, {
      named: args,
      positional:
        positional.length === 0
          ? EMPTY_POSITIONAL
          : argsProxyFor({ positional, named: {} }, 'component').positional,
    });
    const node = delegate.getContext(component) as ComponentNode;
    // gxt tree identity BEFORE gxt adds the node to the render tree (a gxt
    // `Component` gets it as a class field; a manager-created instance does not).
    if (node[COMPONENT_ID_PROPERTY] === undefined) {
      node[COMPONENT_ID_PROPERTY] = cId();
    }
    if (ownTemplate !== undefined) {
      node[$template] = resolveTemplate(ownTemplate, owner, definition);
    } else if (!($template in node)) {
      // no class-body `<template>`: inherited registration, else nothing.
      node[$template] =
        inheritedTemplate === undefined
          ? EMPTY_TEMPLATE
          : resolveTemplate(inheritedTemplate, owner, definition);
    }
    if (delegate.capabilities.destructor && typeof delegate.destroyComponent === 'function') {
      gxtRegisterDestructor(node, () => delegate.destroyComponent!(component));
    }
    DEFINITION_OF_NODE.set(node, definition);
    return node;
  };
}

/** The `$_MANAGERS.component` slot (registered by native/install.ts). */
export const componentManager = {
  canHandle,
  handle: handle as (definition: unknown, args: unknown, fw: unknown, ctx: unknown) => never,
};
