// gxt NATIVE layer — alias target for `@glimmer/reference` (+ `lib/reference`).
//
// Consumers in the native closure are the reused classic modules only:
// InternalComponent / LinkTo (`createConstRef`, `isConstRef`, `valueForRef`),
// the `element` / `unique-id` helpers (`createComputeRef`, `createConstRef`,
// `NULL_REFERENCE`). gxt itself never sees a Reference: the native managers
// (Inc 4/5) adapt gxt args to these shapes at the InternalComponent boundary.
//
// INC-1 PLACEHOLDER: a minimal reference model over native/validator's
// createCache (design §2.2 "~40 lines"). Inc 3 finalizes it (child refs via
// metal get/set, iterator refs only if a native consumer needs them).
import { DEBUG } from '@glimmer/env';
import { type Cache, type Tag, CONSTANT_TAG, createCache, getValue, isConst } from './validator';

export const REFERENCE: unique symbol = Symbol('REFERENCE');

const CONSTANT = 0;
const COMPUTE = 1;
const UNBOUND = 2;
const INVOKABLE = 3;
type ReferenceType = typeof CONSTANT | typeof COMPUTE | typeof UNBOUND | typeof INVOKABLE;

export interface Reference<T = unknown> {
  [REFERENCE]: ReferenceType;
  value: T | undefined;
  compute: (() => T) | null;
  update: ((value: T) => void) | null;
  cache: Cache<T> | null;
  tag: Tag | null;
  children: Map<string, Reference> | null;
  debugLabel?: string | undefined;
}

function makeRef<T>(type: ReferenceType, value?: T): Reference<T> {
  return {
    [REFERENCE]: type,
    value,
    compute: null,
    update: null,
    cache: null,
    tag: type === COMPUTE || type === INVOKABLE ? null : CONSTANT_TAG,
    children: null,
  };
}

export function createPrimitiveRef<T>(value: T): Reference<T> {
  return makeRef(UNBOUND, value);
}

export function createConstRef<T>(value: T, debugLabel?: string | false): Reference<T> {
  const ref = makeRef(CONSTANT, value);
  if (DEBUG && debugLabel) ref.debugLabel = debugLabel;
  return ref;
}

export function createUnboundRef<T>(value: T, debugLabel?: string | false): Reference<T> {
  const ref = makeRef(UNBOUND, value);
  if (DEBUG && debugLabel) ref.debugLabel = debugLabel;
  return ref;
}

export function createComputeRef<T>(
  compute: () => T,
  update: ((value: T) => void) | null = null,
  debugLabel?: string | false
): Reference<T> {
  const ref = makeRef<T>(COMPUTE);
  ref.compute = compute;
  ref.update = update;
  if (DEBUG && debugLabel) ref.debugLabel = `(result of a \`${debugLabel}\` helper)`;
  return ref;
}

export function createReadOnlyRef<T>(ref: Reference<T>): Reference<T> {
  if (!isUpdatableRef(ref)) return ref;
  return createComputeRef(() => valueForRef(ref) as T, null, ref.debugLabel);
}

export function isInvokableRef(ref: Reference): boolean {
  return ref[REFERENCE] === INVOKABLE;
}

export function createInvokableRef<T>(inner: Reference<T>): Reference<T> {
  const ref = createComputeRef(
    () => valueForRef(inner) as T,
    (value: T) => updateRef(inner, value)
  );
  ref[REFERENCE] = INVOKABLE;
  return ref;
}

export function isConstRef(ref: Reference): boolean {
  return ref.tag === CONSTANT_TAG;
}

export function isUpdatableRef(ref: Reference): boolean {
  return ref.update !== null;
}

export function valueForRef<T>(ref: Reference<T>): T {
  if (ref.compute === null) return ref.value as T;
  let cache = ref.cache;
  if (cache === null) cache = ref.cache = createCache(ref.compute);
  const value = getValue(cache) as T;
  if (isConst(cache)) ref.tag = CONSTANT_TAG;
  return value;
}

export function updateRef<T>(ref: Reference<T>, value: T): void {
  if (DEBUG && ref.update === null) throw new Error('called update on a non-updatable reference');
  (ref.update as (value: T) => void)(value);
}

export function childRefFor(parentRef: Reference, path: string): Reference {
  let children = parentRef.children;
  if (children === null) children = parentRef.children = new Map();
  let child = children.get(path);
  if (child === undefined) {
    child = createComputeRef(
      () => {
        const parent = valueForRef(parentRef) as Record<string, unknown> | null | undefined;
        return parent === null || parent === undefined ? undefined : parent[path];
      },
      (value: unknown) => {
        const parent = valueForRef(parentRef) as Record<string, unknown> | null | undefined;
        if (parent !== null && parent !== undefined) parent[path] = value;
      }
    );
    children.set(path, child);
  }
  return child;
}

export function childRefFromParts(root: Reference, parts: string[]): Reference {
  let ref = root;
  for (const part of parts) ref = childRefFor(ref, part);
  return ref;
}

export let createDebugAliasRef: undefined | ((debugLabel: string, inner: Reference) => Reference);

if (DEBUG) {
  createDebugAliasRef = (debugLabel: string, inner: Reference) => {
    const ref = createComputeRef(
      () => valueForRef(inner),
      isUpdatableRef(inner) ? (value: unknown) => updateRef(inner, value) : null
    );
    ref[REFERENCE] = inner[REFERENCE];
    ref.debugLabel = debugLabel;
    return ref;
  };
}

export const UNDEFINED_REFERENCE = createPrimitiveRef(undefined);
export const NULL_REFERENCE = createPrimitiveRef(null);
export const TRUE_REFERENCE = createPrimitiveRef(true);
export const FALSE_REFERENCE = createPrimitiveRef(false);
