// gxt NATIVE layer — the `$_MANAGERS.modifier` slot (design §2.3 "Modifier").
//
// Under NATIVE_FLAGS.EMBER_NATIVE every element modifier compiles to
//   $n => $_maybeModifier(definition, $n, [args], {named}, ctx)
// with literal-or-thunk arguments. gxt evaluates that inside its own
// element-creation formula; since the arguments are thunks it tracks only the
// modifier DEFINITION (a changed definition — `{{(if c (modifier x))}}`,
// `{{this.modifier}}` — re-creates the modifier, Glimmer parity) and keeps the
// destructor `handle` returns.
//
// Lifecycle (Glimmer's environment transaction):
//   - `handle` (element creation): resolve the definition (curried modifier →
//     Glimmer argument rules), create the modifier (`createModifier` /
//     internal `create`) and SCHEDULE its install;
//   - commit (`commitModifiers`, after the render pass / after a root is
//     inserted — the element is in the document by then): install inside a
//     gxt `effect`, which records what the modifier consumed (arguments read
//     through the lazy args proxy, tracked state read by the modifier);
//   - a consumed value changes → the effect re-runs during the next render
//     pass, which only SCHEDULES an update; the update runs at that pass's
//     commit, again inside a fresh tracking effect. `disableAutoTracking`
//     (3.22) runs install / update untracked (no updates, Glimmer parity);
//   - gxt removes the element → the destructor: tracking stops, a pending
//     install is dropped, and the modifier's state is destroyed through Ember
//     destroyables (`destroyModifier` / listener removal run on the run loop,
//     Glimmer parity).
//
// Non-interactive render trees (`renderComponent(…, { env: { isInteractive:
// false } })`, a non-interactive app environment) create no modifiers at all.
import { DEBUG } from '@glimmer/env';
import {
  effect,
  getContext,
  getCurried,
  getTracker,
  isRendering,
  resolveCurried,
} from '@lifeart/gxt';
import { argsProxyFor, type ArgsSource, type Arguments } from './args';
import { destroy, registerDestructor } from './destroyable';
import {
  CustomModifierManager,
  getInternalModifierManager,
  type ModifierDelegate,
} from './manager-api';
import { OWNER } from './managers';
import { notImplemented } from './not-implemented';
import { on, type InternalModifierManager } from './runtime-helpers';
import { untrack } from './validator';

/** gxt context key: `false` on render roots whose modifiers must not run. */
export const INTERACTIVE: unique symbol = Symbol('ember-native-interactive');

interface ModifierInstance {
  readonly element: Element;
  readonly args: Arguments;
  /** The state destroyed (Ember destroyable) when the modifier is removed. */
  readonly state: object;
  install(): void;
  update(): void;
  installed: boolean;
  scheduled: boolean;
  removed: boolean;
  stopTracking: (() => void) | null;
}

const KEYWORD_MODIFIERS: Readonly<Record<string, object>> = { on };
const NO_NAMED: Readonly<Record<string, unknown>> = Object.freeze({});

// ---------------------------------------------------------------- commit queue
let pending: ModifierInstance[] = [];

function schedule(instance: ModifierInstance): void {
  if (instance.scheduled || instance.removed) return;
  instance.scheduled = true;
  pending.push(instance);
}

function run(instance: ModifierInstance): void {
  instance.stopTracking?.();
  // The cells the install / update consumed. A later re-run (one of them
  // changed) re-reads exactly these — so the effect stays bound to the same
  // cells until the commit replaces it, and its teardown unbinds them all — and
  // only schedules the update.
  let consumed: Array<{ value: unknown }> | null = null;
  instance.stopTracking = effect(() => {
    if (consumed === null) {
      if (instance.installed) {
        instance.update();
      } else {
        instance.installed = true;
        instance.install();
      }
      const tracker = getTracker();
      consumed = tracker === null ? [] : (Array.from(tracker) as Array<{ value: unknown }>);
      return;
    }
    for (const cell of consumed) void cell.value;
    schedule(instance);
  });
}

/**
 * Install / update the scheduled modifiers. Called after a render root is
 * inserted and after every render pass (native/renderer.ts, host-hooks.ts) —
 * never while gxt is rendering (a root rendered from inside a pass leaves its
 * modifiers to that pass's commit, when every new element is in place).
 */
export function commitModifiers(): void {
  if (isRendering()) return;
  while (pending.length > 0) {
    const queue = pending;
    pending = [];
    for (const instance of queue) {
      instance.scheduled = false;
      if (!instance.removed) run(instance);
    }
  }
}

function remove(instance: ModifierInstance): void {
  if (instance.removed) return;
  instance.removed = true;
  instance.stopTracking?.();
  instance.stopTracking = null;
  destroy(instance.state);
}

// ---------------------------------------------------------------- create
function createInstance(
  definition: object,
  element: Element,
  source: ArgsSource,
  owner: object | undefined
): ModifierInstance {
  const manager = getInternalModifierManager(definition) as
    | CustomModifierManager
    | InternalModifierManager
    | undefined;
  if (manager === undefined) {
    throw new Error(
      DEBUG
        ? `Attempted to load a modifier, but there wasn't a modifier manager associated with the definition. The definition was: ${
            typeof definition === 'function'
              ? (definition as { name?: string }).name || '(anonymous function)'
              : String(definition)
          }`
        : 'BUG: modifier manager expected'
    );
  }
  const args = argsProxyFor(source, 'modifier');

  if (manager instanceof CustomModifierManager) {
    const delegate = manager.getDelegateFor(owner) as ModifierDelegate;
    const modifier = delegate.createModifier(definition, args);
    const state = {};
    registerDestructor(state, () => delegate.destroyModifier(modifier, args));
    const untracked = delegate.capabilities.disableAutoTracking === true;
    return {
      element,
      args,
      state,
      install: untracked
        ? () => untrack(() => delegate.installModifier(modifier, element, args))
        : () => delegate.installModifier(modifier, element, args),
      update: untracked
        ? () => untrack(() => delegate.updateModifier(modifier, args))
        : () => delegate.updateModifier(modifier, args),
      installed: false,
      scheduled: false,
      removed: false,
      stopTracking: null,
    };
  }

  // Native internal modifier manager (`on`).
  const internalState = manager.create(owner, element, definition, args);
  return {
    element,
    args,
    state: manager.getDestroyable(internalState),
    install: () => manager.install(internalState),
    update: () => manager.update(internalState),
    installed: false,
    scheduled: false,
    removed: false,
    stopTracking: null,
  };
}

// ---------------------------------------------------------------- the slot
function canHandle(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  const type = typeof value;
  // Every function / object is claimed — one without a manager must fail
  // loudly (Glimmer's assertion), never fall through to gxt's function
  // modifier path (which would silently do nothing in an Ember build).
  return type === 'function' || type === 'object' || type === 'string';
}

function handle(
  modifier: unknown,
  element: Element,
  props: readonly unknown[],
  named: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>) | undefined,
  ctx?: unknown
): (() => void) | undefined {
  const renderCtx = ctx !== null && typeof ctx === 'object' ? ctx : undefined;
  if (renderCtx !== undefined && getContext(renderCtx as never, INTERACTIVE, false) === false) {
    return undefined;
  }

  let definition: unknown = modifier;
  let positional = props;
  let namedArgs = (typeof named === 'function' ? named() : named) ?? NO_NAMED;

  if (getCurried(modifier) !== undefined) {
    const resolved = resolveCurried(modifier);
    definition = resolved.definition;
    if (resolved.positional.length > 0) positional = [...resolved.positional, ...props];
    if (resolved.named.length > 0) namedArgs = Object.assign({}, ...resolved.named, namedArgs);
  }

  if (typeof definition === 'string') {
    const keyword = KEYWORD_MODIFIERS[definition];
    if (keyword === undefined) {
      return notImplemented(`native modifier lookup by name ("${definition}", loose mode)`, 8);
    }
    definition = keyword;
  }
  if (definition === null || definition === undefined) return undefined;

  const owner =
    renderCtx === undefined
      ? undefined
      : (getContext<object>(renderCtx as never, OWNER, false) ?? undefined);
  const instance = createInstance(
    definition as object,
    element,
    { positional, named: namedArgs },
    owner
  );
  schedule(instance);
  return () => remove(instance);
}

/** The `$_MANAGERS.modifier` slot (registered by native/install.ts). */
export const modifierManager = {
  canHandle,
  handle: handle as (
    modifier: unknown,
    element: Element,
    props: unknown[],
    hashArgs: () => Record<string, unknown>
  ) => unknown,
};
