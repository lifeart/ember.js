// gxt NATIVE layer — alias target for `@glimmer/validator` and its deep paths
// (`lib/{tracking,validators,meta,tracked-data,utils,debug}`). The vendored
// `lib/collections/*` stay real (they import `../tracking` / `../validators`,
// which the native resolved-path guard redirects HERE).
//
// INC-1 PLACEHOLDER (design §5 row 1). This is a compact, standalone
// revision-counter implementation of the Glimmer tag protocol — the same
// semantics as `packages/@glimmer/validator` (monotonic revision, dirtyable /
// updatable / combinator tags, track frames, lazy createCache) — so that boot
// code (metal `set`/`@tracked`/computed, router, CoreObject) keeps working and
// the first failure a native app hits is the renderer stub, not reactivity.
//
// It is NOT the target design: Inc 3 replaces the internals with gxt cells
// (G12 `tagFor`/`dirtyCell`/`currentRevision`, design §3) so tags and gxt cells
// are ONE reactive system. Keep the export surface; swap the guts.
import { DEBUG } from '@glimmer/env';

export type Revision = number;

export const CONSTANT: Revision = 0;
export const INITIAL: Revision = 1;
export const VOLATILE: Revision = NaN;

export let $REVISION: Revision = INITIAL;

export function bump(): void {
  $REVISION++;
}

export const COMPUTE: unique symbol = Symbol('TAG_COMPUTE');

export interface Tag {
  [COMPUTE](): Revision;
}

export function valueForTag(tag: Tag): Revision {
  return tag[COMPUTE]();
}

export function validateTag(tag: Tag, snapshot: Revision): boolean {
  return snapshot >= tag[COMPUTE]();
}

// DEBUG-only: metal marks intentionally self-referential tags (alias/computed
// chains) here; a cycle on any other tag is an error, as in Glimmer.
export const ALLOW_CYCLES: WeakMap<Tag, boolean> | undefined = DEBUG ? new WeakMap() : undefined;

class MonomorphicTag implements Tag {
  revision = INITIAL;
  lastChecked = INITIAL;
  lastValue = INITIAL;
  isUpdating = false;
  subtag: Tag | Tag[] | null = null;
  subtagBufferCache: Revision | null = null;

  [COMPUTE](): Revision {
    if (this.lastChecked !== $REVISION) {
      if (this.isUpdating) {
        if (DEBUG && !ALLOW_CYCLES?.has(this)) {
          throw new Error('Cycles in tags are not allowed');
        }
        this.lastChecked = ++$REVISION;
      } else {
        this.isUpdating = true;
        this.lastChecked = $REVISION;
        try {
          let revision = this.revision;
          const subtag = this.subtag;
          if (subtag !== null) {
            if (Array.isArray(subtag)) {
              for (const tag of subtag) revision = Math.max(revision, tag[COMPUTE]());
            } else {
              const subtagValue = subtag[COMPUTE]();
              if (subtagValue === this.subtagBufferCache) {
                revision = Math.max(revision, this.lastValue);
              } else {
                this.subtagBufferCache = null;
                revision = Math.max(revision, subtagValue);
              }
            }
          }
          this.lastValue = revision;
        } finally {
          this.isUpdating = false;
        }
      }
    }
    return this.lastValue;
  }
}

export type DirtyableTag = MonomorphicTag;
export type UpdatableTag = MonomorphicTag;

export function createTag(): DirtyableTag {
  return new MonomorphicTag();
}

export function createUpdatableTag(): UpdatableTag {
  return new MonomorphicTag();
}

export const CONSTANT_TAG: Tag = { [COMPUTE]: () => CONSTANT };

export function isConstTag(tag: Tag): boolean {
  return tag === CONSTANT_TAG;
}

export class VolatileTag implements Tag {
  [COMPUTE](): Revision {
    return VOLATILE;
  }
}
export const VOLATILE_TAG = new VolatileTag();

export class CurrentTag implements Tag {
  [COMPUTE](): Revision {
    return $REVISION;
  }
}
export const CURRENT_TAG = new CurrentTag();

export function DIRTY_TAG(tag: Tag, _disableConsumptionAssertion?: boolean): void {
  (tag as MonomorphicTag).revision = ++$REVISION;
}

// Glimmer semantics: the subtag's CURRENT revision is buffered, so swapping
// the subtag does not by itself invalidate the tag.
export function UPDATE_TAG(tag: Tag, subtag: Tag): void {
  const t = tag as MonomorphicTag;
  if (subtag === CONSTANT_TAG) {
    t.subtag = null;
  } else {
    t.subtagBufferCache = subtag[COMPUTE]();
    t.subtag = subtag;
  }
}

export { DIRTY_TAG as dirtyTag, UPDATE_TAG as updateTag };

export function combine(tags: Tag[]): Tag {
  const live = tags.filter((t) => t !== CONSTANT_TAG);
  if (live.length === 0) return CONSTANT_TAG;
  if (live.length === 1) return live[0] as Tag;
  const tag = new MonomorphicTag();
  tag.subtag = live;
  return tag;
}

// ---------------------------------------------------------------- tracking
class Tracker {
  tags = new Set<Tag>();
  last: Tag | null = null;
  add(tag: Tag) {
    if (tag === CONSTANT_TAG) return;
    this.tags.add(tag);
    this.last = tag;
  }
  combine(): Tag {
    const { tags } = this;
    if (tags.size === 0) return CONSTANT_TAG;
    if (tags.size === 1) return this.last as Tag;
    return combine(Array.from(tags));
  }
}

let CURRENT_TRACKER: Tracker | null = null;
const STACK: (Tracker | null)[] = [];

export function beginTrackFrame(_debuggingContext?: string | false): void {
  STACK.push(CURRENT_TRACKER);
  CURRENT_TRACKER = new Tracker();
}

export function endTrackFrame(): Tag {
  const current = CURRENT_TRACKER;
  if (DEBUG && STACK.length === 0)
    throw new Error('attempted to close a tracking frame, but one was not open');
  CURRENT_TRACKER = STACK.pop() as Tracker | null;
  return (current as Tracker).combine();
}

export function beginUntrackFrame(): void {
  STACK.push(CURRENT_TRACKER);
  CURRENT_TRACKER = null;
}

export function endUntrackFrame(): void {
  if (DEBUG && STACK.length === 0)
    throw new Error('attempted to close a tracking frame, but one was not open');
  CURRENT_TRACKER = STACK.pop() as Tracker | null;
}

export function resetTracking(): void {
  STACK.length = 0;
  CURRENT_TRACKER = null;
}

export function isTracking(): boolean {
  return CURRENT_TRACKER !== null;
}

export function consumeTag(tag: Tag): void {
  if (CURRENT_TRACKER !== null) CURRENT_TRACKER.add(tag);
}

export function track(block: () => void, debugLabel?: string | false): Tag {
  beginTrackFrame(debugLabel);
  let tag: Tag;
  try {
    block();
  } finally {
    tag = endTrackFrame();
  }
  return tag;
}

export function untrack<T>(callback: () => T): T {
  beginUntrackFrame();
  try {
    return callback();
  } finally {
    endUntrackFrame();
  }
}

export interface Cache<T = unknown> {
  fn: () => T;
  value: T | undefined;
  tag: Tag | undefined;
  snapshot: Revision;
}

export function createCache<T>(fn: () => T, _debuggingLabel?: string | false): Cache<T> {
  if (DEBUG && typeof fn !== 'function') {
    throw new Error(
      `createCache() must be passed a function as its first parameter. Called with: ${String(fn)}`
    );
  }
  return { fn, value: undefined, tag: undefined, snapshot: -1 };
}

export function getValue<T>(cache: Cache<T>): T | undefined {
  const { tag, snapshot } = cache;
  if (tag === undefined || !validateTag(tag, snapshot)) {
    beginTrackFrame();
    let newTag: Tag;
    try {
      cache.value = cache.fn();
    } finally {
      newTag = endTrackFrame();
      cache.tag = newTag;
      cache.snapshot = valueForTag(newTag);
    }
    consumeTag(newTag);
  } else {
    consumeTag(tag);
  }
  return cache.value;
}

export function isConst(cache: Cache): boolean {
  if (cache.tag === undefined) getValue(cache);
  return isConstTag(cache.tag as Tag);
}

// ---------------------------------------------------------------- meta
export type TagMeta = Map<PropertyKey, UpdatableTag>;
const TRACKED_TAGS = new WeakMap<object, TagMeta>();

export function tagMetaFor(obj: object): TagMeta {
  let tags = TRACKED_TAGS.get(obj);
  if (tags === undefined) {
    tags = new Map();
    TRACKED_TAGS.set(obj, tags);
  }
  return tags;
}

export function tagFor(obj: object, key: PropertyKey, meta?: TagMeta): UpdatableTag {
  const tags = meta === undefined ? tagMetaFor(obj) : meta;
  let tag = tags.get(key);
  if (tag === undefined) {
    tag = createUpdatableTag();
    tags.set(key, tag);
  }
  return tag;
}

export function dirtyTagFor(obj: object, key: PropertyKey, meta?: TagMeta): void {
  const tags = meta === undefined ? TRACKED_TAGS.get(obj) : meta;
  const tag = tags?.get(key);
  if (tag !== undefined) DIRTY_TAG(tag);
}

// ---------------------------------------------------------------- tracked-data
export function trackedData<T extends object, K extends keyof T>(
  key: K,
  initializer?: (this: T) => T[K]
): { getter: (self: T) => T[K] | undefined; setter: (self: T, value: T[K]) => void } {
  const values = new WeakMap<T, T[K]>();
  const hasInitializer = typeof initializer === 'function';
  return {
    getter(self: T) {
      consumeTag(tagFor(self, key));
      if (hasInitializer && !values.has(self)) {
        const value = (initializer as (this: T) => T[K]).call(self);
        values.set(self, value);
        return value;
      }
      return values.get(self);
    },
    setter(self: T, value: T[K]) {
      dirtyTagFor(self, key);
      values.set(self, value);
    },
  };
}

// ---------------------------------------------------------------- debug / utils
// The Glimmer render-transaction debug hooks (backtracking assertion) are G13
// (Inc 9); until then the transaction object is empty, exactly like a prod
// Glimmer build.
export const debug: Record<string, unknown> = {};

export function unwrap<T>(val: T | null | undefined): T {
  if (val === null || val === undefined) throw new Error(`Expected value to be present`);
  return val;
}
