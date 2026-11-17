/**
 * Where a write of a classic component's argument goes (two-way binding), as
 * gxt's compiler emitted it.
 *
 * gxt's compat compiler brands the getter of every component argument and
 * gives the getter of a path argument its source (gxt `argSource`): the object
 * the path's last segment is a property of, and that property — as Glimmer's
 * reference for the path writes. The host records, for each args object it
 * builds from an invocation's `@name` getters (compile.ts,
 * ember-gxt-wrappers.ts), the source of each argument, and the component
 * manager (manager.ts) writes a two-way bound argument there instead of
 * guessing the source from the reads the getter makes.
 */
import { argSource as gxtArgSource, isArgThunk as gxtIsArgThunk } from '@lifeart/gxt';

export interface GxtArgSource {
  /** Reads the object the write sets a property of (when the write happens). */
  readonly parent: () => unknown;
  /** The property, or `@name` for the caller's argument `name` (see below). */
  readonly key: string;
}

// The sources of the arguments of each args object: an argument the compiler
// emitted without a source (a literal, a helper's result, a block param
// itself) is `null`: not writable.
const argSources = new WeakMap<object, Map<string, GxtArgSource | null>>();

/**
 * Record the source of the argument `key` of `args`, whose value is `value` as
 * the invocation passed it. A value gxt's compiler gave no source (not one of
 * its component argument getters) tells nothing: its argument's source is left
 * to the manager's guess.
 */
export function recordArgSource(args: object, key: string, value: unknown): void {
  if (!gxtIsArgThunk(value)) return;
  const source = gxtArgSource(value);
  if (source === undefined) return;
  let sources = argSources.get(args);
  if (sources === undefined) {
    sources = new Map();
    argSources.set(args, sources);
  }
  sources.set(key, source === null ? null : { parent: source[0], key: source[1] });
}

/**
 * `target` reads the arguments of `args` (a component's render-context args
 * object): its arguments' sources are those of `args`.
 */
export function shareArgSources(target: object, args: object): void {
  const sources = argSources.get(args);
  if (sources !== undefined && target !== args) argSources.set(target, sources);
}

/**
 * The source of the argument `key` of `args`: `undefined` when gxt's compiler
 * told nothing about it (the manager guesses), `null` when the argument is
 * not writable, else where a write of it goes.
 */
export function compiledArgSource(args: object, key: string): GxtArgSource | null | undefined {
  return argSources.get(args)?.get(key);
}

/**
 * The object and property a write of an argument with `source` sets, or
 * `null` when there is none. A source keyed `@name` is the caller's argument
 * `name` of the args object its parent reads (`{{inner value=@x}}`): it is
 * followed to where that argument writes, as Glimmer's `@x` is the caller's
 * reference; an argument the caller passed as a literal or a helper's result
 * is not writable.
 */
export function resolveArgWrite(source: GxtArgSource): readonly [object, string] | null {
  let parent = source.parent();
  let key = source.key;
  for (let depth = 0; depth < 32; depth++) {
    if (parent === null || (typeof parent !== 'object' && typeof parent !== 'function')) {
      return null;
    }
    if (!key.startsWith('@')) return [parent, key];
    // The caller's argument: not writable, or nothing known about it (an
    // argument the compiler gave no source): nothing is written.
    const outer = argSources.get(parent)?.get(key.slice(1));
    if (outer === undefined || outer === null) return null;
    parent = outer.parent();
    key = outer.key;
  }
  return null;
}
