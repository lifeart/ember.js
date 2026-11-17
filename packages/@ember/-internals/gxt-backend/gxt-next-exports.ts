/**
 * gxt exports newer than the `@lifeart/gxt` release Ember pins: the gxt this
 * branch builds and tests with has them, the pinned release's types do not
 * yet. They are read from the module by name, so the type check against the
 * pinned release passes; with a gxt that lacks them, each falls back to the
 * behaviour Ember had before it (the feature it serves is off).
 */
import * as gxt from '@lifeart/gxt';

const next = gxt as unknown as {
  argSource?: (fn: unknown) => readonly [() => unknown, string] | null | undefined;
  argumentOf?: (args: object, key: string) => unknown;
  isItemSlotParam?: (param: unknown) => boolean;
};

/**
 * Where a write of a component argument gxt's compiler emitted goes (gxt
 * `argSource`): `[parent, key]`, `null` (not writable) or `undefined` (gxt said
 * nothing).
 */
export const gxtArgSource: (fn: unknown) => readonly [() => unknown, string] | null | undefined =
  next.argSource ?? (() => undefined);

/**
 * The argument `key` of an args object gxt's `$_args` built (its angle-bracket
 * invocations), as the compiler passed it: its getter, which carries its
 * source (gxt `argumentOf`); `undefined` for any other object.
 */
export const gxtArgumentOf: (args: object, key: string) => unknown =
  next.argumentOf ?? (() => undefined);

/**
 * Whether a yielded param follows a list row's item (gxt `isItemSlotParam`).
 */
export const gxtIsItemSlotParam: (param: unknown) => boolean =
  next.isItemSlotParam ?? (() => false);
