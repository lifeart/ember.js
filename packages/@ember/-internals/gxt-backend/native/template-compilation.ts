// gxt NATIVE layer — alias target for `@ember/template-compilation`.
//
// `precompileTemplate()` is a BUILD-TIME macro. In the native build the gxt
// compiler will consume it (G10 → Inc 8: `scope: () => ({…})` = lexical,
// `strictMode: false` = loose). Until then a surviving call (e.g. the loose
// modern-app flavor) returns a PLACEHOLDER factory (template-factory.ts): module
// evaluation and `factory(owner)` stay clean, rendering the result throws — so
// the first boot failure is the real gap rather than an import-time crash.
//
// `compileTemplate()` (runtime compilation) works once a runtime compiler has
// been registered (`__registerTemplateCompiler`) — the native entry for that is
// `native/runtime-compile.ts` (Inc 7, tests / @ember/template-compiler/runtime).
import { placeholderTemplateFactory } from './template-factory';

interface TemplateCompiler {
  compile(...args: unknown[]): unknown;
}

export let __emberTemplateCompiler: undefined | TemplateCompiler;

export function __registerTemplateCompiler(c: TemplateCompiler): void {
  __emberTemplateCompiler = c;
}

export const compileTemplate = (...args: unknown[]): unknown => {
  if (!__emberTemplateCompiler) {
    throw new Error(
      'Attempted to call `compileTemplate` without first loading the runtime template compiler.'
    );
  }
  return __emberTemplateCompiler.compile(...args);
};

export function precompileTemplate(
  _templateString: string,
  _options?: { strictMode?: boolean; scope?: () => Record<string, unknown>; moduleName?: string }
): (owner?: unknown) => () => never {
  return placeholderTemplateFactory(
    'native precompileTemplate (must be compiled at build time by the gxt compiler, G10)',
    8
  );
}
