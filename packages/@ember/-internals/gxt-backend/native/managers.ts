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
  $template,
  cId,
  COMPONENT_ID_PROPERTY,
  getContext,
  isTemplateFn,
  registerDestructor as gxtRegisterDestructor,
} from '@lifeart/gxt';
import {
  CustomComponentManager,
  FROM_CAPABILITIES,
  getComponentTemplate,
  getInternalComponentManager,
  getOwnComponentTemplate,
} from './manager-api';
import { notImplemented } from './not-implemented';
import { TemplateOnlyComponentDefinition } from './runtime-helpers';
import { templateFor, type GxtTemplate } from './template-factory';

/** gxt context key for the Ember owner of a render tree (provided on roots). */
export const OWNER: unique symbol = Symbol('ember-native-owner');

interface ComponentDelegate {
  capabilities: { destructor?: boolean };
  createComponent(definition: object, args: { named: object; positional: unknown[] }): object;
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

// ---------------------------------------------------------------- component
function canHandle(definition: unknown): boolean {
  if (definition === null || definition === undefined) return false;
  const type = typeof definition;
  if (type !== 'object' && type !== 'function') return false;
  if (definition instanceof TemplateOnlyComponentDefinition) return true;
  if (isTemplateFn(definition)) return false;
  return getInternalComponentManager(definition as object) !== undefined;
}

function handle(definition: object, args: object, _fw: unknown, ctx: object): unknown {
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
      positional: EMPTY_POSITIONAL,
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
