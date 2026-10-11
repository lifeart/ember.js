// gxt NATIVE layer — alias target for `@glimmer/destroyable` (re-exported
// unchanged by `@ember/destroyable`).
//
// Ember's two-phase destruction semantics, scheduled on backburner directly
// (classic does the same through @glimmer/global-context's scheduleDestroy /
// scheduleDestroyed, which ember's environment.ts wires to the `actions` and
// `destroy` queues — that global-context hop is not part of the native closure):
//   destroy(x): isDestroying(x) = true now; children destroyed; eager
//   destructors run now; destructors run in the runloop `actions` queue;
//   isDestroyed(x) = true in the `destroy` queue.
//
// INC-1 PLACEHOLDER: standalone registry. Inc 3 bridges it to gxt's per-object
// destructor registry (registerDestructor / associateDestroyableChild /
// isDestructionStarted) so gxt component nodes and Ember children form ONE
// destruction graph (design §2.2, §7 risk 9).
import { DEBUG } from '@glimmer/env';
import { schedule } from '@ember/runloop';

type Destroyable = object;
type Destructor<T extends Destroyable> = (destroyable: T) => void;

const LIVE = 0;
const DESTROYING = 1;
const DESTROYED = 2;

interface Meta {
  parents: Destroyable[];
  children: Destroyable[];
  eagerDestructors: Destructor<any>[];
  destructors: Destructor<any>[];
  state: typeof LIVE | typeof DESTROYING | typeof DESTROYED;
}

const META = new WeakMap<Destroyable, Meta>();

function metaFor(destroyable: Destroyable): Meta {
  let meta = META.get(destroyable);
  if (meta === undefined) {
    meta = { parents: [], children: [], eagerDestructors: [], destructors: [], state: LIVE };
    META.set(destroyable, meta);
  }
  return meta;
}

function removeFrom<T>(list: T[], item: T, message: string): void {
  const index = list.indexOf(item);
  if (index === -1) {
    if (DEBUG) throw new Error(message);
    return;
  }
  list.splice(index, 1);
}

export function associateDestroyableChild<T extends Destroyable>(parent: Destroyable, child: T): T {
  if (DEBUG && isDestroying(parent)) {
    throw new Error(
      'Attempted to associate a destroyable child with an object that is already destroying or destroyed'
    );
  }
  metaFor(parent).children.push(child);
  metaFor(child).parents.push(parent);
  return child;
}

export function registerDestructor<T extends Destroyable>(
  destroyable: T,
  destructor: Destructor<T>,
  eager = false
): Destructor<T> {
  if (DEBUG && isDestroying(destroyable)) {
    throw new Error(
      'Attempted to register a destructor with an object that is already destroying or destroyed'
    );
  }
  const meta = metaFor(destroyable);
  (eager ? meta.eagerDestructors : meta.destructors).push(destructor);
  return destructor;
}

export function unregisterDestructor<T extends Destroyable>(
  destroyable: T,
  destructor: Destructor<T>,
  eager = false
): void {
  if (DEBUG && isDestroying(destroyable)) {
    throw new Error(
      'Attempted to unregister a destructor with an object that is already destroying or destroyed'
    );
  }
  const meta = metaFor(destroyable);
  removeFrom(
    eager ? meta.eagerDestructors : meta.destructors,
    destructor,
    'attempted to remove a destructor that was not registered with the destroyable'
  );
}

export function destroy(destroyable: Destroyable): void {
  const meta = metaFor(destroyable);
  if (meta.state >= DESTROYING) return;
  meta.state = DESTROYING;

  const { parents, children, eagerDestructors, destructors } = meta;
  for (const child of children.slice()) destroy(child);
  for (const destructor of eagerDestructors) destructor(destroyable);
  for (const destructor of destructors) schedule('actions', null, destructor, destroyable);

  schedule('destroy', null, () => {
    for (const parent of parents) {
      const parentMeta = metaFor(parent);
      if (parentMeta.state !== DESTROYED) {
        removeFrom(
          parentMeta.children,
          destroyable,
          "attempted to remove child from parent, but the parent's children did not contain the child. This is likely a bug with destructors."
        );
      }
    }
    meta.state = DESTROYED;
  });
}

export function destroyChildren(destroyable: Destroyable): void {
  for (const child of metaFor(destroyable).children.slice()) destroy(child);
}

export function _hasDestroyableChildren(destroyable: Destroyable): boolean {
  const meta = META.get(destroyable);
  return meta === undefined ? false : meta.children.length > 0;
}

export function isDestroying(destroyable: Destroyable): boolean {
  const meta = META.get(destroyable);
  return meta === undefined ? false : meta.state >= DESTROYING;
}

export function isDestroyed(destroyable: Destroyable): boolean {
  const meta = META.get(destroyable);
  return meta === undefined ? false : meta.state >= DESTROYED;
}

// DEBUG-only leak tracking used by @ember/test-helpers (Inc 3 ports the
// Glimmer implementation; until then both are absent, as in a prod build).
export let enableDestroyableTracking: undefined | (() => void);
export let assertDestroyablesDestroyed: undefined | (() => void);
