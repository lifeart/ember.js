import { meta as metaFor } from '@ember/-internals/meta/lib/meta';
import { isEmberArray } from '@ember/array/-internals';
import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import { getGxtRenderer } from '@ember/-internals/gxt-backend/gxt-bridge';
// In GXT builds `@glimmer/validator` is aliased to gxt-backend's validator
// shim, which exposes the same named exports. The barrel specifier is
// load-bearing: the alias map (scripts/gxt-alias-map.mjs) redirects the exact
// '@glimmer/validator' key, so deep lib/* paths would resolve to the real VM
// source in GXT builds.
// eslint-disable-next-line ember-local/no-barrel-imports
import * as validator from '@glimmer/validator';
// eslint-disable-next-line ember-local/no-barrel-imports
import {
  consumeTag as compatConsumeTag,
  tagFor as compatTagFor,
  trackedData as compatTrackedData,
} from '@glimmer/validator';

import type { ElementDescriptor } from '..';
import { CHAIN_PASS_THROUGH } from './chain-tags';
import type { ExtendedMethodDecorator, DecoratorPropertyDescriptor } from './decorator';
import { COMPUTED_SETTERS, isElementDescriptor, setClassicDecorator } from './decorator';
import { notifyPropertyChange } from './property_events';

// Use compat trackedData for backtracking detection support.
// The native GXT trackedData doesn't support backtracking detection.
const trackedData = compatTrackedData;

// Use compat versions that integrate with createCache tracking
const consumeTag = compatConsumeTag;
const tagFor = compatTagFor;

// GXT-only backtracking bookkeeping on the single tracked cell. These live on
// the gxt-backend validator shim (classic `@glimmer/validator` does not export
// them, so they are `undefined` there); only ever invoked under `__GXT_MODE__`.
// Accessed via the namespace import to avoid a classic-build link error on a
// missing named export.
const _gxtRecordTrackedRead = (validator as { recordTrackedCellRead?: unknown })
  .recordTrackedCellRead as
  | ((cell: unknown, key: string | symbol, obj: object) => void)
  | undefined;
const _gxtAssertTrackedBacktrack = (validator as { assertTrackedCellBacktrack?: unknown })
  .assertTrackedCellBacktrack as
  | ((cell: unknown, key: string | symbol, obj: object) => void)
  | undefined;

/**
  @decorator
  @private

  Marks a property as tracked.

  By default, a component's properties are expected to be static,
  meaning you are not able to update them and have the template update accordingly.
  Marking a property as tracked means that when that property changes,
  a rerender of the component is scheduled so the template is kept up to date.

  There are two usages for the `@tracked` decorator, shown below.

  @example No dependencies

  If you don't pass an argument to `@tracked`, only changes to that property
  will be tracked:

  ```typescript
  import Component from '@glimmer/component';
  import { tracked } from '@glimmer/tracking';

  export default class MyComponent extends Component {
    @tracked
    remainingApples = 10
  }
  ```

  When something changes the component's `remainingApples` property, the rerender
  will be scheduled.

  @example Dependents

  In the case that you have a computed property that depends other
  properties, you want to track both so that when one of the
  dependents change, a rerender is scheduled.

  In the following example we have two properties,
  `eatenApples`, and `remainingApples`.

  ```typescript
  import Component from '@glimmer/component';
  import { tracked } from '@glimmer/tracking';

  const totalApples = 100;

  export default class MyComponent extends Component {
    @tracked
    eatenApples = 0

    get remainingApples() {
      return totalApples - this.eatenApples;
    }

    increment() {
      this.eatenApples = this.eatenApples + 1;
    }
  }
  ```

  @param dependencies Optional dependents to be tracked.
*/
export function tracked(propertyDesc: {
  value: any;
  initializer: () => any;
}): ExtendedMethodDecorator;
export function tracked(target: object, key: string): void;
export function tracked(
  target: object,
  key: string,
  desc: DecoratorPropertyDescriptor
): DecoratorPropertyDescriptor;
export function tracked(...args: any[]): ExtendedMethodDecorator | DecoratorPropertyDescriptor {
  assert(
    `@tracked can only be used directly as a native decorator. If you're using tracked in classic classes, add parenthesis to call it like a function: tracked()`,
    !(isElementDescriptor(args.slice(0, 3)) && args.length === 5 && args[4] === true)
  );

  if (!isElementDescriptor(args)) {
    let propertyDesc = args[0];

    assert(
      `tracked() may only receive an options object containing 'value' or 'initializer', received ${propertyDesc}`,
      args.length === 0 || (typeof propertyDesc === 'object' && propertyDesc !== null)
    );

    if (DEBUG && propertyDesc) {
      let keys = Object.keys(propertyDesc);

      assert(
        `The options object passed to tracked() may only contain a 'value' or 'initializer' property, not both. Received: [${keys}]`,
        keys.length <= 1 &&
          (keys[0] === undefined || keys[0] === 'value' || keys[0] === 'initializer')
      );

      assert(
        `The initializer passed to tracked must be a function. Received ${propertyDesc.initializer}`,
        !('initializer' in propertyDesc) || typeof propertyDesc.initializer === 'function'
      );
    }

    let initializer = propertyDesc ? propertyDesc.initializer : undefined;
    let value = propertyDesc ? propertyDesc.value : undefined;

    let decorator = function (
      target: object,
      key: string,
      _desc?: DecoratorPropertyDescriptor,
      _meta?: any,
      isClassicDecorator?: boolean
    ): DecoratorPropertyDescriptor {
      assert(
        `You attempted to set a default value for ${key} with the @tracked({ value: 'default' }) syntax. You can only use this syntax with classic classes. For native classes, you can use class initializers: @tracked field = 'default';`,
        isClassicDecorator
      );

      let fieldDesc = {
        initializer: initializer || (() => value),
      };

      return descriptorForField([target, key, fieldDesc]);
    };

    setClassicDecorator(decorator);

    return decorator;
  }

  return descriptorForField(args);
}

if (DEBUG) {
  // Normally this isn't a classic decorator, but we want to throw a helpful
  // error in development so we need it to treat it like one
  setClassicDecorator(tracked);
}

// ── GXT @tracked storage ───────────────────────────────────────────────────
// In GXT mode a `@tracked` property is backed by exactly one gxt cell,
// `cellFor(obj, key)`, which is also the cell `tagFor(obj, key)` resolves to
// (gxt keeps both in one per-property store). The accessor reads and writes
// that cell, and Ember's createCache/computed/observer tracking consumes the
// same cell via `consumeTag(tagFor(obj, key))`. Classic mode keeps
// `@glimmer/validator`'s `trackedData`.
//
// Re-entrancy guard (load-bearing): gxt's `cellFor` creates the cell with
// `new Cell(obj[key])` and `tagFor` creates a lazy formula `() => obj[key]`.
// For a `@tracked` property `obj[key]` is this very accessor, so the first
// access re-enters the getter before the cell exists and recurses forever.
// The guard makes that re-entrant `obj[key]` read return the memoized
// initializer value, which seeds the cell and resolves the lazy formula;
// after that the cell is self-sufficient.
let _gxtSeedObj: object | null = null;
let _gxtSeedKey: string | symbol | null = null;
let _gxtSeedInit: (() => unknown) | null = null;
let _gxtSeedComputed = false;
let _gxtSeedValue: unknown;

// Pre-install-window write migration. A `@tracked` write that lands BEFORE the
// gxt `cellFor` bridge is installed (the metal module-init window) has no cell
// to write yet, so it is stashed in the classic `trackedData` storage and the
// (obj, key) is flagged here. On the cell's first post-install creation we
// migrate that stashed value into the cell (see `_gxtTrackedCellGet`). Only
// flagged props ever read classic storage.
const _gxtPendingWindowWrites = new WeakMap<object, Set<string | symbol>>();
function _gxtFlagPendingWindowWrite(obj: object, key: string | symbol): void {
  let set = _gxtPendingWindowWrites.get(obj);
  if (set === undefined) {
    set = new Set();
    _gxtPendingWindowWrites.set(obj, set);
  }
  set.add(key);
}
function _gxtTakePendingWindowWrite(obj: object, key: string | symbol): boolean {
  const set = _gxtPendingWindowWrites.get(obj);
  if (set !== undefined && set.has(key)) {
    set.delete(key);
    return true;
  }
  return false;
}

function _gxtTrackedCellGet(
  obj: object,
  key: string | symbol,
  initializer: () => unknown,
  classicGetter: (obj: object) => unknown
): unknown {
  // Re-entrant read from gxt cell creation / lazy-formula resolution — return
  // the memoized seed instead of recursing back through this accessor.
  if (_gxtSeedObj === obj && _gxtSeedKey === key) {
    if (!_gxtSeedComputed) {
      // Seed the cell being created. If a value was written during the
      // pre-install window, migrate it from classic storage; otherwise use the
      // initializer default (normal props never read classic storage).
      _gxtSeedValue = _gxtTakePendingWindowWrite(obj, key)
        ? classicGetter(obj)
        : (_gxtSeedInit ?? initializer).call(obj);
      _gxtSeedComputed = true;
    }
    return _gxtSeedValue;
  }
  const _cellFor = getGxtRenderer()?.compilePipeline.cellFor;
  if (typeof _cellFor !== 'function') {
    // Bridge not installed yet (metal module-init window, before compile.ts has
    // run its install) — fall back to the classic storage so no read is lost.
    return classicGetter(obj);
  }
  const pObj = _gxtSeedObj;
  const pKey = _gxtSeedKey;
  const pInit = _gxtSeedInit;
  const pComputed = _gxtSeedComputed;
  const pValue = _gxtSeedValue;
  _gxtSeedObj = obj;
  _gxtSeedKey = key;
  _gxtSeedInit = initializer;
  _gxtSeedComputed = false;
  try {
    // skipDefine=true: get-or-create the cell WITHOUT replacing the @tracked
    // get/set descriptor. The guard above is active for both the construction-
    // time `new Cell(obj[key])` read and the `cell.value` resolution read.
    const cell = _cellFor(obj, key, /* skipDefine */ true) as { value: unknown } | undefined;
    // Entangle Ember's createCache/computed on the SAME cell: tagFor(obj,key)
    // returns this very cell (shared per-property store inside @lifeart/gxt).
    const tag = tagFor(obj, key);
    consumeTag(tag);
    // Record the read for DEV backtracking detection on the SAME cell (the
    // setter asserts against it). Replaces the trackedData getter's recording.
    if (DEBUG) _gxtRecordTrackedRead?.(tag, key, obj);
    return cell ? cell.value : undefined;
  } finally {
    _gxtSeedObj = pObj;
    _gxtSeedKey = pKey;
    _gxtSeedInit = pInit;
    _gxtSeedComputed = pComputed;
    _gxtSeedValue = pValue;
  }
}

function _gxtTrackedCellSet(
  obj: object,
  key: string | symbol,
  newValue: unknown,
  initializer: () => unknown
): boolean {
  const _cellFor = getGxtRenderer()?.compilePipeline.cellFor;
  if (typeof _cellFor !== 'function') return false;
  const apply = () => {
    const cell = _cellFor(obj, key, /* skipDefine */ true) as
      | { update: (v: unknown) => void }
      | undefined;
    // This relies on the gxt cell exposing a synchronous `update()` (tagFor's
    // lazy MergedCell extends Cell). Assert it in DEBUG so a gxt contract
    // change fails loudly here rather than silently dropping a @tracked write.
    assert(
      `@tracked single-cell: gxt cellFor("${String(key)}") returned a cell without update(); the gxt cell contract changed`,
      !cell || typeof cell.update === 'function'
    );
    if (cell) cell.update(newValue);
  };
  if (_gxtSeedObj === obj && _gxtSeedKey === key) {
    apply();
    return true;
  }
  const pObj = _gxtSeedObj;
  const pKey = _gxtSeedKey;
  const pInit = _gxtSeedInit;
  const pComputed = _gxtSeedComputed;
  const pValue = _gxtSeedValue;
  _gxtSeedObj = obj;
  _gxtSeedKey = key;
  _gxtSeedInit = initializer;
  _gxtSeedComputed = false;
  try {
    // Guard active so the construction-time `new Cell(obj[key])` read (when the
    // cell doesn't exist yet) returns the seed instead of recursing.
    apply();
  } finally {
    _gxtSeedObj = pObj;
    _gxtSeedKey = pKey;
    _gxtSeedInit = pInit;
    _gxtSeedComputed = pComputed;
    _gxtSeedValue = pValue;
  }
  return true;
}

function descriptorForField([target, key, desc]: ElementDescriptor): DecoratorPropertyDescriptor {
  assert(
    `You attempted to use @tracked on ${key}, but that element is not a class field. @tracked is only usable on class fields. Native getters and setters will autotrack add any tracked fields they encounter, so there is no need mark getters and setters with @tracked.`,
    !desc || (!desc.value && !desc.get && !desc.set)
  );

  // Always pass a function initializer to trackedData so GXT's cellFor creates
  // a cell with a safe getter (instead of reading back through the property
  // descriptor, which causes infinite recursion).
  const initializer = desc?.initializer ?? (() => undefined);
  let { getter, setter } = trackedData<any, any>(key, initializer);

  function get(this: object): unknown {
    // GXT mode: read the property's gxt cell, which also consumes
    // `tagFor(obj, key)` so Ember's createCache/computed tracking captures the
    // dependency. Classic mode: the `trackedData` getter consumes the tag.
    let value = __GXT_MODE__ ? _gxtTrackedCellGet(this, key, initializer, getter) : getter(this);

    // Add the tag of the returned value if it is an array, since arrays
    // should always cause updates if they are consumed and then changed
    if (Array.isArray(value) || isEmberArray(value)) {
      consumeTag(tagFor(value, '[]'));
    }

    return value;
  }

  function set(this: object, newValue: unknown): void {
    // GXT backtracking detection for @tracked properties (render-pass based:
    // "modified X after it was rendered").
    if (__GXT_MODE__ && DEBUG) {
      getGxtRenderer()?.backtracking.checkBacktracking?.(this, key);
      // track()/render-frame backtracking ("updated X after using it in the
      // same computation") on the same cell the getter recorded its read into.
      _gxtAssertTrackedBacktrack?.(tagFor(this, key), key, this);
    }

    if (__GXT_MODE__) {
      // Write the property's gxt cell, the only value store on the GXT path.
      const wrote = _gxtTrackedCellSet(this, key, newValue, initializer);
      if (!wrote) {
        // Bridge not installed yet (metal module-init window, before the gxt
        // renderer is set). Stash in the classic storage so a pre-install READ
        // still sees it, and flag (this, key) so the cell's first post-install
        // creation migrates this value in instead of seeding the initializer
        // default (which would silently drop this write). Framework-init-only.
        setter(this, newValue);
        _gxtFlagPendingWindowWrite(this, key);
      }
      // notifyPropertyChange dirties the `key` and SELF_TAG tags (invalidating
      // createCache/computed/observers), fires observers, recomputes dependent
      // computed properties and triggers the GXT re-render. `newValue` is
      // forwarded so the trigger does not re-read the getter.
      notifyPropertyChange(this, key, null, newValue);
    } else {
      setter(this, newValue);
    }
  }

  let newDesc = {
    enumerable: true,
    configurable: true,
    isTracked: true,

    get,
    set,
  };

  COMPUTED_SETTERS.add(set);

  metaFor(target).writeDescriptors(key, new TrackedDescriptor(get, set));

  return newDesc;
}

export class TrackedDescriptor {
  constructor(
    private _get: () => unknown,
    private _set: (value: unknown) => void
  ) {
    CHAIN_PASS_THROUGH.add(this);
  }

  get(obj: object): unknown {
    return this._get.call(obj);
  }

  set(obj: object, _key: string, value: unknown): void {
    this._set.call(obj, value);
  }
}
