// The GXT force re-render of glimmer's classic roots (`ClassicRootState` in
// glimmer/lib/renderer.ts), moved here from renderer.ts: gxt-backend's DOM
// sync re-renders the roots whose tag moved, asks whether an object is a
// root's component, and advances the render-pass id through the members this
// module installs on the gxt-bridge renderer when it loads (glimmer-host.ts
// imports it).
import type { RendererState } from '@ember/-internals/glimmer/lib/base-renderer';
import { renderers } from '@ember/-internals/glimmer/lib/renderers';
// The @glimmer/validator BARREL specifier is load-bearing: the GXT alias map
// (scripts/gxt-alias-map.mjs) redirects the exact barrel key to the
// gxt-backend shim, while a deep lib/* path would resolve to the real vendored
// VM source and fork the reactive runtime.
import { valueForTag } from '@glimmer/validator';
import {
  getGxtRenderer,
  installCompilePipelinePart,
  installRootComponentPart,
  installViewUtilsPart,
} from './gxt-bridge';

// Re-entrancy guard for `_gxtForceEmberRerender`.
let _gxtForceRerenderInProgress = false;

// Dirty roots recorded by `_gxtUpdateRootTagValues` during a GXT DOM sync,
// consumed (and cleared) by `_gxtForceEmberRerender` in the same sync.
let _gxtDirtyRootsAtSync: any[] | undefined;

// Force re-render all GXT roots whose own tag moved in the current sync
// cycle. gxt-backend calls this (as `compilePipeline.forceEmberRerender`) from
// its DOM sync when GXT's cell tracking misses changes made through Ember's
// set() / notifyPropertyChange, and from the helper-recompute path so formulas
// reading helper cells re-evaluate.
function _gxtForceEmberRerender(): void {
  // Re-entrancy guard: prevent infinite loops when re-rendering triggers
  // cell updates that schedule additional force-rerenders.
  if (_gxtForceRerenderInProgress) return;
  _gxtForceRerenderInProgress = true;
  try {
    const hadPendingSync = Boolean(getGxtRenderer()?.compilePipeline.getHadPendingSync?.());
    const hadNestedObjectChange = Boolean(
      getGxtRenderer()?.compilePipeline.getHadNestedObjectChange?.()
    );
    // Collect roots whose own tag has moved. If `_gxtUpdateRootTagValues`
    // already ran earlier in this sync, it stashed the dirty list in
    // `_gxtDirtyRootsAtSync`; prefer that.
    const dirtyRootsFromSync = _gxtDirtyRootsAtSync;
    const dirtyRoots: any[] = [];
    const allGxtRoots: any[] = [];
    // Roots whose previous render() threw mid-way (gxtRenderIncomplete) —
    // they never wired gxtComponentTag, so the tag comparison below cannot
    // select them. They are retried unconditionally; see the field doc on
    // ClassicRootState.
    const incompleteRoots: any[] = [];
    for (const renderer of renderers) {
      const state = (renderer as any).state as RendererState;
      if (!state) continue;
      const debugRoots = state.debug?.roots;
      if (!debugRoots) continue;
      for (const root of debugRoots) {
        const classicRoot = root as any;
        if (classicRoot.isGxt && (classicRoot.gxtComponentTag || classicRoot.isOutletView)) {
          allGxtRoots.push(classicRoot);
          const currentTagValue = classicRoot.gxtComponentTag
            ? valueForTag(classicRoot.gxtComponentTag)
            : 0;
          if (currentTagValue !== classicRoot.gxtLastTagValue) {
            dirtyRoots.push(classicRoot);
          }
        } else if (classicRoot.gxtRenderIncomplete === true && !classicRoot.destroyed) {
          incompleteRoots.push(classicRoot);
        }
      }
    }
    // Use the pre-sync dirty set (captured before updateRootTagValues cleaned
    // them), falling back to live comparison for call-sites that don't go
    // through the sync pipeline.
    const effectiveDirtyRoots =
      dirtyRootsFromSync && dirtyRootsFromSync.length > 0
        ? dirtyRootsFromSync.filter((r) => allGxtRoots.includes(r))
        : dirtyRoots;
    // Choose which roots to force-render:
    //   - If any root's own tag moved in this sync, render only those (scoped).
    //     This is the common case: a component mutates its own @tracked state.
    //   - Otherwise, fall back to force-render-all only when hadPendingSync AND
    //     hadNestedObjectChange — i.e., a nested-object property change that
    //     doesn't dirty any component's SELF_TAG (e.g., set(m, 'message', ...)).
    //     This preserves cross-root propagation for nested object mutations
    //     while avoiding spurious full re-renders when a @tracked mutation on
    //     a CHILD component doesn't change any root's tag (child is reactive
    //     via its own cell-tracked getters).
    const selectedRoots =
      effectiveDirtyRoots.length > 0
        ? effectiveDirtyRoots
        : hadPendingSync && hadNestedObjectChange
          ? allGxtRoots
          : [];
    // Incomplete roots retry regardless of the tag-based selection (a copy —
    // selectedRoots may alias one of the arrays built above). Gate on
    // hadPendingSync: only an actual classic mutation justifies a retry —
    // without the gate the 16ms interval flush would re-run a still-throwing
    // root every tick and the rethrown error would wedge the suite.
    const rootsToRender =
      incompleteRoots.length > 0 && hadPendingSync
        ? [...new Set([...selectedRoots, ...incompleteRoots])]
        : selectedRoots;
    for (const classicRoot of rootsToRender) {
      // Tag is dirty — force re-render. Increment the render pass ID
      // so the instance pool resets claimed flags and REUSES existing
      // instances instead of creating new ones (which would fire
      // spurious init/render lifecycle hooks).
      _incrementEmberRenderPassId();
      // Render inside `withForceRerender` so gxt-backend knows a forced
      // rerender is in progress. The render error is stashed inside the
      // wrapped body, before the flag is reset.
      const _renderFn = () => {
        try {
          classicRoot.render();
        } catch (renderErr) {
          // Store render error so it can propagate to assert.throws
          if (!classicRoot.__gxtDeferredError) {
            classicRoot.__gxtDeferredError = renderErr;
          }
        }
      };
      const _withForceRerender = getGxtRenderer()?.compilePipeline.withForceRerender;
      if (_withForceRerender) {
        _withForceRerender(_renderFn);
      } else {
        _renderFn();
      }
      // Re-throw deferred errors (from lifecycle hooks like destroy)
      if (classicRoot.__gxtDeferredError) {
        const err = classicRoot.__gxtDeferredError;
        classicRoot.__gxtDeferredError = null;
        if (classicRoot.gxtRenderIncomplete === true) {
          // A recovery retry that threw again: queue the error for the test
          // harness instead of rethrowing — a throw here would abort the
          // force pass mid-loop and wedge subsequent flushes. The flag stays
          // set, so the next classic mutation retries again (classic prod
          // semantics: renders keep being attempted after an error).
          const capture = getGxtRenderer()?.compilePipeline.captureRenderError;
          if (typeof capture === 'function') capture(err);
        } else {
          throw err;
        }
      }
    }
  } finally {
    _gxtForceRerenderInProgress = false;
    getGxtRenderer()?.compilePipeline.setHadPendingSync?.(false);
    getGxtRenderer()?.compilePipeline.setHadNestedObjectChange?.(false);
    _gxtDirtyRootsAtSync = undefined;
  }
}

// Expose `_gxtForceEmberRerender` to gxt-backend.
if (__GXT_MODE__) {
  installCompilePipelinePart({
    forceEmberRerender: _gxtForceEmberRerender,
  });
}

// Check if the given object is a GXT root-component's `root` (i.e., a
// component that owns a top-level renderer state). Used by the GXT re-render
// trigger to distinguish own-SELF_TAG changes (which the cell-based sync
// pipeline handles) from nested-object changes (which need a force-rerender
// fallback).
function _gxtIsRootComponent(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const renderer of renderers) {
    const state = (renderer as any).state as RendererState;
    if (!state) continue;
    const debugRoots = state.debug?.roots;
    if (!debugRoots) continue;
    for (const root of debugRoots) {
      if ((root as any).root === obj) return true;
    }
  }
  return false;
}

// Update gxtLastTagValue on all GXT roots to mark them clean. Called from
// gxt-backend's DOM sync after the cell-based updates, so
// `_gxtForceEmberRerender` sees them as up to date. Also records which roots
// WERE dirty (in `_gxtDirtyRootsAtSync`) so `_gxtForceEmberRerender` can scope
// its rerender to just those roots.
function _gxtUpdateRootTagValues(): void {
  const dirtyRoots: any[] = [];
  for (const renderer of renderers) {
    const state = (renderer as any).state as RendererState;
    if (!state) continue;
    const debugRoots = state.debug?.roots;
    if (!debugRoots) continue;
    for (const root of debugRoots) {
      const classicRoot = root as any;
      if (classicRoot.isGxt && classicRoot.gxtComponentTag) {
        const currentTagValue = valueForTag(classicRoot.gxtComponentTag);
        if (currentTagValue !== classicRoot.gxtLastTagValue) {
          dirtyRoots.push(classicRoot);
        }
        classicRoot.gxtLastTagValue = currentTagValue;
      }
    }
  }
  _gxtDirtyRootsAtSync = dirtyRoots;
}

// Publish the renderer-owned root-component hooks to the gxt-bridge
// `rootComponent` namespace (consumed by gxt-backend/compile.ts).
if (__GXT_MODE__) {
  installRootComponentPart({
    isRootComponent: _gxtIsRootComponent,
    updateRootTagValues: _gxtUpdateRootTagValues,
  });
}

// Render pass ID, incremented before each forced root re-render and by the
// rendering test helpers. Exposed to gxt-backend through `viewUtils`.
let _emberRenderPassId = 0;
function _getEmberRenderPassId(): number {
  return _emberRenderPassId;
}
function _incrementEmberRenderPassId(): void {
  _emberRenderPassId = _emberRenderPassId + 1;
}
if (__GXT_MODE__) {
  installViewUtilsPart({
    getRenderPassId: _getEmberRenderPassId,
    incrementRenderPassId: _incrementEmberRenderPassId,
  });
}
