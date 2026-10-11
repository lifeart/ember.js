// gxt NATIVE layer — the `$_MANAGERS.helper` slot (design §2.3 "Helper", G4).
//
// Under NATIVE_FLAGS.EMBER_NATIVE every helper invocation compiles to
//   $_maybeHelper(definition, [args], {named}, ctx, site)
// (literal-or-thunk arguments, the enclosing render context, a per-template
// call-site index) and gxt hands every value this manager claims to `handle`.
//
// One helper INSTANCE per call site instance — keyed on (ctx, site), destroyed
// when gxt destroys `ctx` (the template / block instance holding the call
// site). That is the lifetime of a Glimmer helper reference (created once per
// call site per block, associated with the block). Its value is a native
// `createCache` over the manager's `getValue`: an evaluation of the call site
// whose consumed tags are unchanged returns the cached value without
// re-running the helper (gxt reads each binding twice on create — the helper
// still computes once) and re-consumes those tags into the reading binding
// formula, so it stays subscribed.
//
// Definitions:
//   - a curried helper (`(helper X 1)`, G9): resolved with Glimmer's rules —
//     curried positional first, later named arguments win;
//   - a public custom manager (`setHelperManager`, capabilities 3.23; the
//     classic `Helper` class and `helper()` wrapper use it): delegate per owner,
//     `createHelper(definition, args)`, `getValue`, `getDestroyable` destroyed
//     with the call site;
//   - a plain function: the default (function) helper manager (manager-api
//     DEFAULT_HELPER_MANAGER) — positional arguments + the named hash as a
//     trailing argument when non-empty;
//   - an INTERNAL helper (`(capturedArgs, owner) => Reference`: `hash`,
//     `array`, `concat`, `get`, `fn`, `and`, `or`, classic `unique-id` /
//     `element`): one native reference per argument, the helper called once
//     per call site;
//   - a string: an unbound Ember keyword helper gxt does not compile natively
//     (`neq`, `gt`, …; Ember auto-imports them in strict mode). Any other name
//     is a loose-mode lookup (Inc 8).
import { DEBUG } from '@glimmer/env';
import {
  getContext,
  getCurried,
  registerDestructor as gxtRegisterDestructor,
  resolveCurried,
} from '@lifeart/gxt';
import { argsProxyFor, unwrapArg, type ArgsSource } from './args';
import { _hasDestroyableChildren, destroy, isDestroying } from './destroyable';
import { getInternalHelperManager, CustomHelperManager, type HelperDelegate } from './manager-api';
import { OWNER } from './managers';
import { notImplemented } from './not-implemented';
import { createComputeRef, valueForRef, type Reference } from './reference';
import { KEYWORD_HELPERS, type InternalHelper } from './runtime-helpers';
import { createCache, getValue, type Cache } from './validator';

interface HelperInstance {
  readonly definition: unknown;
  /** The call site's current arguments (updated per evaluation). */
  readonly source: ArgsSource;
  readonly cache: Cache;
  /** What destroying the call site destroys (Ember destroyable), if any. */
  readonly destroyable: object | null;
}

const NO_NAMED: Readonly<Record<string, unknown>> = Object.freeze({});

function ownerOf(ctx: unknown): object | undefined {
  if (ctx === null || ctx === undefined) return undefined;
  const owner = getContext<object>(ctx as never, OWNER, false);
  return owner === null ? undefined : owner;
}

function describe(value: unknown): string {
  if (typeof value === 'function')
    return (value as { name?: string }).name || '(anonymous function)';
  return String(value);
}

/**
 * The helper instance for one call site. `source` holds the call site's
 * current arguments; it is updated on every evaluation of the call site.
 */
function createInstance(
  definition: object,
  owner: object | undefined,
  source: ArgsSource
): HelperInstance {
  const manager = getInternalHelperManager(definition) as
    | CustomHelperManager
    | InternalHelper
    | undefined;

  if (typeof manager === 'function') {
    // Internal helper (Glimmer protocol): one reference per argument over the
    // call site's source (a call site's arity and named keys never change),
    // the helper invoked ONCE per call site.
    const positional = source.positional.map((_, i) =>
      createComputeRef(() => unwrapArg(source.positional[i]))
    );
    const named: Record<string, Reference> = {};
    for (const key of Object.keys(source.named)) {
      named[key] = createComputeRef(() => unwrapArg(source.named[key]));
    }
    const ref = manager({ positional, named }, owner);
    return {
      definition,
      source,
      cache: createCache(() => valueForRef(ref)),
      destroyable: _hasDestroyableChildren(ref) ? ref : null,
    };
  }

  if (manager instanceof CustomHelperManager) {
    const delegate = manager.getDelegateFor(owner) as HelperDelegate;
    const args = argsProxyFor(source, 'helper');
    const bucket = delegate.createHelper(definition, args);
    const cache = delegate.capabilities.hasValue
      ? createCache(() => delegate.getValue!(bucket), DEBUG && delegate.getDebugName?.(definition))
      : createCache(() => undefined);
    const destroyable = delegate.capabilities.hasDestroyable
      ? (delegate.getDestroyable!(bucket) ?? null)
      : null;
    return { definition, source, cache, destroyable };
  }

  throw new Error(
    DEBUG
      ? `Attempted to use a value as a helper, but it was not an object or function. Helper definitions must be objects or functions with an associated helper manager. The value was: ${describe(definition)}`
      : 'BUG: helper manager expected'
  );
}

// ---------------------------------------------------------------- call sites
const SITES = new WeakMap<object, Map<number, HelperInstance>>();

function destroyInstance(instance: HelperInstance): void {
  const { destroyable } = instance;
  if (destroyable !== null && !isDestroying(destroyable)) destroy(destroyable);
}

function instanceFor(
  ctx: object,
  site: number,
  definition: object,
  positional: readonly unknown[],
  named: Readonly<Record<string, unknown>>
): HelperInstance {
  let sites = SITES.get(ctx);
  if (sites === undefined) {
    sites = new Map();
    SITES.set(ctx, sites);
    const owned = sites;
    // The call sites live as long as the render context holding them.
    gxtRegisterDestructor(ctx as never, () => {
      SITES.delete(ctx);
      for (const instance of owned.values()) destroyInstance(instance);
      owned.clear();
    });
  }
  let instance = sites.get(site);
  if (instance !== undefined && instance.definition === definition) {
    instance.source.positional = positional;
    instance.source.named = named;
    return instance;
  }
  // First evaluation — or a dynamic helper (`{{(this.helper) …}}`) whose
  // definition changed: a new instance; the outgoing one is destroyed.
  if (instance !== undefined) destroyInstance(instance);
  instance = createInstance(definition, ownerOf(ctx), { positional, named });
  sites.set(site, instance);
  return instance;
}

// ---------------------------------------------------------------- the slot
function canHandle(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const type = typeof value;
  if (type === 'function' || type === 'string') return true;
  return type === 'object' && getInternalHelperManager(value as object) !== undefined;
}

function handle(
  value: unknown,
  args: readonly unknown[],
  named: Readonly<Record<string, unknown>> | undefined,
  ctx?: unknown,
  site?: number
): unknown {
  let definition: unknown = value;
  let positional = args;
  let namedArgs = named ?? NO_NAMED;

  if (getCurried(value) !== undefined) {
    const resolved = resolveCurried(value);
    definition = resolved.definition;
    if (resolved.positional.length > 0) positional = [...resolved.positional, ...args];
    if (resolved.named.length > 0) namedArgs = Object.assign({}, ...resolved.named, namedArgs);
  }

  if (typeof definition === 'string') {
    const keyword = KEYWORD_HELPERS[definition];
    if (keyword === undefined) {
      return notImplemented(`native helper lookup by name ("${definition}", loose mode)`, 8);
    }
    definition = keyword;
  }

  if (definition === null || definition === undefined) return undefined;

  if (ctx !== null && typeof ctx === 'object' && typeof site === 'number') {
    return getValue(instanceFor(ctx, site, definition as object, positional, namedArgs).cache);
  }
  // No call site to own it (not compiler-emitted): a one-shot invocation.
  const instance = createInstance(definition as object, ownerOf(ctx), {
    positional,
    named: namedArgs,
  });
  try {
    return getValue(instance.cache);
  } finally {
    destroyInstance(instance);
  }
}

/** The `$_MANAGERS.helper` slot (registered by native/install.ts). */
export const helperManager = {
  canHandle,
  handle: handle as (helper: unknown, params: unknown[], hash: unknown) => unknown,
};
