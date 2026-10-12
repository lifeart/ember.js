import { next, run, _getCurrentRunLoop, _hasScheduledTimers } from '@ember/runloop';
import { destroy } from '@glimmer/destroyable';
import { getGxtRenderer } from '@ember/-internals/gxt-backend/gxt-bridge';

import { Promise } from 'rsvp';

export function runAppend(view: any): void {
  if (__GXT_MODE__) {
    gxtRunAppend(view);
    return;
  }
  run(view, 'appendTo', document.getElementById('qunit-fixture'));
}

// GXT: `runAppend` that suppresses the end-of-loop DOM sync during the initial
// render and syncs explicitly afterwards.
function gxtRunAppend(view: any): void {
  // Suppress the run loop's end-of-loop GXT DOM sync during initial render.
  // Property changes from component init mark a sync as pending, and syncing
  // mid-render would re-evaluate each-formulas with stale values (e.g. `[]`
  // instead of the actual collection). We sync explicitly below instead.
  getGxtRenderer()?.compilePipeline.setRunTaskActive?.(true);
  try {
    run(view, 'appendTo', document.getElementById('qunit-fixture'));
  } catch (e) {
    // gxt-backend captures a copy of a render error into its render-error
    // queue before rethrowing it. The caller already observes this throw, so
    // drop the queued copy; otherwise the next runTask() would rethrow it
    // and break error-recovery tests (`assert.throws(() => render(...))`
    // followed by `runTask(...)`).
    getGxtRenderer()?.compilePipeline.clearRenderErrors?.();
    throw e;
  } finally {
    getGxtRenderer()?.compilePipeline.setRunTaskActive?.(false);
  }
  // Keep the "pending sync from property change" flag only if the change came
  // from a `schedule('afterRender', cb)` callback (e.g. `didInsertElement`
  // queueing a `set` that must re-render before the test asserts). Property
  // changes made during init (e.g. Textarea's internal bindings) must not
  // trigger a full sync.
  const _cpAR = getGxtRenderer()?.compilePipeline;
  const afterRenderChanged = Boolean(_cpAR?.getAfterRenderPropertyChange?.());
  _cpAR?.setAfterRenderPropertyChange?.(false);
  if (!afterRenderChanged) {
    getGxtRenderer()?.compilePipeline.setPendingSyncFromPropertyChange?.(false);
  }
  // In GXT mode, flush pending DOM updates synchronously after append
  // so test assertions see the rendered DOM immediately.
  getGxtRenderer()?.compilePipeline.resetManagedComponentCounters?.();
  getGxtRenderer()?.compilePipeline.syncDomNow?.();
  // Clear sync flags set during the sync itself so the 16ms fallback flusher
  // does not run another sync that would re-evaluate each-formulas with stale
  // values.
  const _cpRA = getGxtRenderer()?.compilePipeline;
  _cpRA?.setPendingSync?.(false);
  _cpRA?.setPendingSyncFromPropertyChange?.(false);
  _cpRA?.resetIntervalBudget?.();
  // Render errors are rethrown by the renderer within the render cycle that
  // produced them, so no flush is needed here.
}

export function runDestroy(toDestroy: any): void {
  if (toDestroy) {
    if (__GXT_MODE__) {
      gxtRunDestroy(toDestroy);
      return;
    }
    run(destroy, toDestroy);
  }
}

// GXT: `runDestroy` that tolerates "already destroyed" teardown errors and also
// destroys the class-based helper instances GXT tracks.
function gxtRunDestroy(toDestroy: any): void {
  try {
    run(destroy, toDestroy);
  } catch (e: any) {
    // Swallow "already destroyed" errors during test cleanup
    if (e && e.message && e.message.includes('after the owner has been destroyed')) {
      return;
    }
    throw e;
  }
  // In GXT mode, also destroy tracked class-based helper instances so their
  // `willDestroy` / `destroy` lifecycle runs.
  const helperInstances = getGxtRenderer()?.compilePipeline.getHelperInstances?.();
  if (Array.isArray(helperInstances) && helperInstances.length > 0) {
    for (const inst of helperInstances) {
      try {
        if (typeof inst.destroy === 'function' && !inst.isDestroyed && !inst.isDestroying) {
          inst.destroy();
        }
      } catch {
        /* ignore */
      }
    }
    helperInstances.length = 0;
  }
  // Also clear the helper instance cache
  getGxtRenderer()?.compilePipeline.clearHelperCache?.();
}

export function runTask<F extends () => any>(callback: F): ReturnType<F> {
  if (__GXT_MODE__) {
    return gxtRunTask(callback);
  }
  return run(callback);
}

// GXT: `runTask` that syncs the GXT DOM explicitly after the task.
function gxtRunTask<F extends () => any>(callback: F): ReturnType<F> {
  // Mark that we're inside runTask so the run loop's end hook doesn't
  // double-sync the GXT DOM (runTask has its own explicit sync below).
  getGxtRenderer()?.compilePipeline.setRunTaskActive?.(true);
  let result: ReturnType<F>;
  try {
    result = run(callback);
  } catch (e) {
    // Drop the queued copy of the escaping error (see runAppend).
    getGxtRenderer()?.compilePipeline.clearRenderErrors?.();
    throw e;
  } finally {
    getGxtRenderer()?.compilePipeline.setRunTaskActive?.(false);
  }
  // In GXT mode, flush pending DOM updates synchronously after the task
  // so test assertions see the updated DOM immediately. Advance the
  // managed-component generation first so slot counters reset.
  getGxtRenderer()?.compilePipeline.resetManagedComponentCounters?.();
  getGxtRenderer()?.compilePipeline.syncDomNow?.();
  // The explicit sync above handled all pending updates; clear the flags so
  // the 16ms fallback flusher does not run another sync.
  const _cpRT = getGxtRenderer()?.compilePipeline;
  _cpRT?.setPendingSync?.(false);
  _cpRT?.setPendingSyncFromPropertyChange?.(false);
  // Also clear tagsToRevalidate to prevent stale cells from re-evaluating
  const clearTags = (globalThis as any).__gxtClearTagsToRevalidate;
  if (typeof clearTags === 'function') clearTags();
  // Reset interval sync budget after an explicit runTask sync
  _cpRT?.resetIntervalBudget?.();
  // Errors thrown while destroying components during the sync are rethrown
  // by `syncDomNow()` above, so no render-error flush is needed here.
  return result;
}

export function runTaskNext(): Promise<void> {
  return new Promise((resolve) => {
    return next(resolve);
  });
}

// TODO: Find a better name 😎
export function runLoopSettled(event?: any): Promise<void> {
  return new Promise(function (resolve) {
    // Every 5ms, poll for the async thing to have finished
    let watcher = setInterval(() => {
      // If there are scheduled timers or we are inside of a run loop, keep polling
      if (_hasScheduledTimers() || _getCurrentRunLoop()) {
        return;
      }

      // Stop polling
      clearInterval(watcher);

      // Synchronously resolve the promise
      resolve(event);
    }, 5);
  });
}
