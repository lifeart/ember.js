/**
 * gxt exports newer than the `@lifeart/gxt` release Ember pins: the gxt this
 * branch builds and tests with has them, the pinned release's types do not
 * yet. They are read from the module by name, so the type check against the
 * pinned release passes; with a gxt that lacks them, each falls back to the
 * behaviour Ember had before it (the feature it serves is off).
 */
import * as gxt from '@lifeart/gxt';

const next = gxt as unknown as {
  isItemSlotParam?: (param: unknown) => boolean;
};

/**
 * Whether a yielded param follows a list row's item (gxt `isItemSlotParam`).
 */
export const gxtIsItemSlotParam: (param: unknown) => boolean =
  next.isItemSlotParam ?? (() => false);
