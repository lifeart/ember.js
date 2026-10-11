// gxt NATIVE layer — alias target for the `@glimmer/runtime` deep imports that
// classic Ember's public modules re-export:
//   `@glimmer/runtime/lib/helpers/*`        (@ember/helper)
//   `@glimmer/runtime/lib/modifiers/on`     (@ember/modifier `on`)
//   `@glimmer/runtime/lib/component/template-only` (@ember/component/template-only)
//
// Native shape (design §2.2 runtime-helpers.ts): the keyword helpers are PLAIN
// functions driven by the default (function) helper manager — `fn(...positional,
// named?)` — instead of Glimmer internal-helper definitions that build
// References. Values are computed per call; gxt's formulas give the reactivity.
//
// INC-1 STATUS: the pure keyword helpers below are complete enough to keep;
// Inc 5 wires them through G4 ($_maybeHelper → $_MANAGERS.helper) and G-kw
// (Ember toBool/arity semantics inside gxt's `$__and/$__or/$__not/$__eq`).
// `invokeHelper` and `on` need the manager protocol and are Inc-5 placeholders;
// `templateOnlyComponent` is the definition marker Inc 4's component manager
// consumes.
import { DEBUG } from '@glimmer/env';
import { get as emberGet } from '@ember/-internals/metal/lib/property_get';
import toBool from '@ember/-internals/glimmer/lib/utils/to-bool';
import { notImplemented } from './not-implemented';

function assertArity(name: string, args: unknown[], expected: number) {
  if (DEBUG && args.length !== expected) {
    throw new Error(
      `\`${name}\` expects exactly ${expected} argument${expected === 1 ? '' : 's'}, but received ${args.length}.`
    );
  }
}

export function array<T>(...items: T[]): T[] {
  return items;
}

export function hash<T extends Record<string, unknown>>(named?: T): T {
  return named ?? ({} as T);
}

export function concat(...parts: unknown[]): string {
  return parts
    .map((value) =>
      value === null ||
      value === undefined ||
      typeof (value as { toString?: unknown }).toString !== 'function'
        ? ''
        : String(value)
    )
    .join('');
}

export function get(obj: unknown, path: unknown): unknown {
  if (obj === null || obj === undefined || path === null || path === undefined) return undefined;
  return emberGet(obj as object, String(path));
}

export function fn(callback: unknown, ...partial: unknown[]): (...args: unknown[]) => unknown {
  if (DEBUG && typeof callback !== 'function') {
    throw new Error(
      `You must pass a function as the \`fn\` helper's first argument, you passed ${String(callback)}.`
    );
  }
  return (...args: unknown[]) => (callback as (...a: unknown[]) => unknown)(...partial, ...args);
}

export function eq(...args: unknown[]): boolean {
  assertArity('eq', args, 2);
  return args[0] === args[1];
}
export function neq(...args: unknown[]): boolean {
  assertArity('neq', args, 2);
  return args[0] !== args[1];
}
export function gt(...args: unknown[]): boolean {
  assertArity('gt', args, 2);
  return (args[0] as number) > (args[1] as number);
}
export function gte(...args: unknown[]): boolean {
  assertArity('gte', args, 2);
  return (args[0] as number) >= (args[1] as number);
}
export function lt(...args: unknown[]): boolean {
  assertArity('lt', args, 2);
  return (args[0] as number) < (args[1] as number);
}
export function lte(...args: unknown[]): boolean {
  assertArity('lte', args, 2);
  return (args[0] as number) <= (args[1] as number);
}

export function and(...args: unknown[]): unknown {
  if (DEBUG && args.length < 2) {
    throw new Error(`\`and\` expects at least two arguments, but received ${args.length}.`);
  }
  let last: unknown;
  for (const arg of args) {
    last = arg;
    if (!toBool(last)) return last;
  }
  return last;
}

export function or(...args: unknown[]): unknown {
  if (DEBUG && args.length < 2) {
    throw new Error(`\`or\` expects at least two arguments, but received ${args.length}.`);
  }
  let last: unknown;
  for (const arg of args) {
    last = arg;
    if (toBool(last)) return last;
  }
  return last;
}

export function not(...args: unknown[]): boolean {
  assertArity('not', args, 1);
  return !toBool(args[0]);
}

export function invokeHelper(..._args: unknown[]): never {
  notImplemented('native invokeHelper', 5);
}

// `{{on}}` definition object. Inc 5 makes it a native modifier (add/remove
// listener on handler-identity change, options, asserts — design §2.3).
export function on(..._args: unknown[]): never {
  notImplemented('native {{on}} modifier', 5);
}

export class TemplateOnlyComponentDefinition {
  constructor(
    readonly moduleName = '@glimmer/component/template-only',
    readonly name = '(unknown template-only component)'
  ) {}
  toString(): string {
    return this.moduleName;
  }
}

export function templateOnlyComponent(
  moduleName?: string,
  name?: string
): TemplateOnlyComponentDefinition {
  return new TemplateOnlyComponentDefinition(moduleName, name);
}
