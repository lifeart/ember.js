// gxt NATIVE layer — alias target for `@glimmer/opcode-compiler/lib/template`
// (re-exported by `@ember/template-factory` as `createTemplateFactory`), plus
// the brand that tells native code "this function is an Ember-style
// TemplateFactory (`factory(owner) -> template`)" apart from a raw gxt template
// function.
//
// The native build has no wire-format templates: AOT templates are gxt
// template functions (the `.gjs`/`.gts` gxt compiler output), and babel's
// classic `precompileTemplate` → wire-format pass is OFF in native
// (babel.config.mjs). A wire-format `createTemplateFactory(...)` call can only
// come from a stale pre-compiled addon. Such factories (and the
// `precompileTemplate` placeholder, Inc 8) are PLACEHOLDERS: `factory(owner)`
// succeeds (route.ts calls it while building the RenderState) and returns a
// template that fails when RENDERED — so the first failure is at the render
// boundary that owns the gap.
//
// Inc 4 turns this into the branded gxt template-fn factory
// (`f(owner) -> f`, `f.__fn`; G14 brand) used by native route/component lookup.
import { notImplemented } from './not-implemented';

const NATIVE_TEMPLATE_FACTORIES = new WeakSet<object>();

export function isNativeTemplateFactory(value: unknown): boolean {
  return typeof value === 'function' && NATIVE_TEMPLATE_FACTORIES.has(value);
}

export function placeholderTemplateFactory(
  what: string,
  inc: number
): (owner?: unknown) => () => never {
  const template = (): never => notImplemented(what, inc);
  const factory = () => template;
  NATIVE_TEMPLATE_FACTORIES.add(factory);
  return factory;
}

export default function templateFactory(_serialized: unknown): (owner?: unknown) => () => never {
  return placeholderTemplateFactory('native template factory (wire-format templates)', 4);
}
