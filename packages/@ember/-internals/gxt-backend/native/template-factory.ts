// gxt NATIVE layer — alias target for `@glimmer/opcode-compiler/lib/template`
// (re-exported by `@ember/template-factory` as `createTemplateFactory`).
//
// Two function-shaped template values exist in the native build, and native
// code must never confuse them:
//   - a gxt TEMPLATE FUNCTION: the compiled `<template>` of a template-only
//     `.gjs`/`.gts` (a route template, `const Foo = <template>…</template>`).
//     The gxt compiler brands it under NATIVE_FLAGS.EMBER_NATIVE (G14, `$_tpl`);
//     `isTemplateFn` reads the brand. gxt renders it directly.
//   - an Ember TEMPLATE FACTORY (`factory(owner) -> template`): produced here.
//     `templateFactory(gxtTemplateFn)` wraps a template function (the factory
//     returns it for every owner); wire-format input (a stale pre-compiled
//     addon — the native build has no wire format) and the `precompileTemplate`
//     / `template:-outlet` placeholders produce PLACEHOLDER factories whose
//     template throws when RENDERED (the gap is owned by a later increment).
// `templateFor(value, owner)` resolves either shape (what a component's
// `setComponentTemplate` registration holds) to a gxt template function.
import { $SELF, $template, cId, COMPONENT_ID_PROPERTY, isTemplateFn } from '@lifeart/gxt';
import { notImplemented } from './not-implemented';

export type GxtTemplate = (...args: unknown[]) => unknown;
export type NativeTemplateFactory = ((owner?: unknown) => GxtTemplate) & {
  readonly __fn?: GxtTemplate;
};

const NATIVE_TEMPLATE_FACTORIES = new WeakSet<object>();

// Part of the `@glimmer/opcode-compiler/lib/template` surface (re-exported by
// the opcode-compiler index and `@ember/-internals/glimmer`). The native build
// has no template cache, so the counters stay 0.
export const templateCacheCounters = { cacheHit: 0, cacheMiss: 0 };

export function isNativeTemplateFactory(value: unknown): value is NativeTemplateFactory {
  return typeof value === 'function' && NATIVE_TEMPLATE_FACTORIES.has(value);
}

function brand(factory: NativeTemplateFactory): NativeTemplateFactory {
  NATIVE_TEMPLATE_FACTORIES.add(factory);
  return factory;
}

/** A TemplateFactory over a gxt template function (same template for every owner). */
export function factoryForTemplate(template: GxtTemplate): NativeTemplateFactory {
  const factory = (() => template) as NativeTemplateFactory;
  Object.defineProperty(factory, '__fn', { value: template });
  return brand(factory);
}

export function placeholderTemplateFactory(
  what: string,
  inc: number | string
): NativeTemplateFactory {
  const template: GxtTemplate = () => notImplemented(what, inc);
  return brand((() => template) as NativeTemplateFactory);
}

/**
 * Resolve a component's template value to a gxt template function: a branded
 * template function is returned as-is, a native TemplateFactory is invoked
 * with the owner. Anything else is not a native template (`undefined`).
 */
export function templateFor(value: unknown, owner: unknown): GxtTemplate | undefined {
  if (isTemplateFn(value)) return value as GxtTemplate;
  if (isNativeTemplateFactory(value)) return value(owner);
  return undefined;
}

// ---------------------------------------------------------------- loose / self
// A LOOSE template (runtime-compiled with `strictMode: false`: a test's
// `this.render('…')`, an ApplicationTestCase / `.hbs` route template) is not a
// component: `this` is an object the host supplies — the route's controller,
// the test context. It is compiled with NATIVE_FLAGS.EMBER_SELF (G6), so its
// `this` paths read `$_self(node)` = `node[$SELF]`, and it is rendered through
// `selfComponent`: a fresh gxt render node carrying the self, so gxt never
// writes args / tree ids / rendered nodes onto the controller or test context.
const LOOSE_TEMPLATES = new WeakSet<object>();

/** Mark a runtime-compiled template function as loose (`this` = a host self). */
export function markLooseTemplate(template: GxtTemplate): void {
  LOOSE_TEMPLATES.add(template);
}

/** True for a loose template function (see markLooseTemplate). */
export function isLooseTemplate(value: unknown): value is GxtTemplate {
  return typeof value === 'function' && LOOSE_TEMPLATES.has(value);
}

/**
 * A gxt-constructible definition that renders `template` with `self` as the
 * self of its `this` paths (G6). gxt constructs it per invocation (`new
 * SelfComponent(args)`), adds the returned node to the render tree and calls
 * `node[$template](args)` with `this` = the node.
 */
export function selfComponent(
  template: GxtTemplate,
  self: unknown
): (...args: unknown[]) => object {
  return function SelfComponent(): object {
    return { [COMPONENT_ID_PROPERTY]: cId(), [$SELF]: self, [$template]: template };
  };
}

export default function templateFactory(serialized: unknown): NativeTemplateFactory {
  if (isTemplateFn(serialized)) return factoryForTemplate(serialized as GxtTemplate);
  return placeholderTemplateFactory(
    'native template factory (wire-format templates; compile with the gxt compiler, G10)',
    8
  );
}
