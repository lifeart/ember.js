// gxt NATIVE layer — host hooks registered with gxt (design §2.2 `host-hooks.ts`).
//
// Inc 3: `scheduleRevalidate` only. gxt calls it for every cell change and for
// every Ember tag dirty (G12 `dirtyCell` is the single DIRTY_TAG path), so it
// IS Glimmer's global-context `scheduleRevalidate`: exactly like classic
// environment.ts, it ensures a backburner instance so the change is seen at the
// end of that (auto)run loop — async observers flush there, `settled()` waits
// for it. Registering it also stops gxt's own microtask `syncDom` scheduling;
// Inc 4 adds the render flush here (pending flag +
// `_backburner.scheduleOnce('render', …, syncDom)`, design §3 "Scheduling").
import { _backburner } from '@ember/runloop';
import { registerHostHooks } from '@lifeart/gxt';

let installed = false;

export function installHostHooks(): void {
  if (installed) return;
  installed = true;
  registerHostHooks({
    scheduleRevalidate(): void {
      _backburner.ensureInstance();
    },
  });
}
