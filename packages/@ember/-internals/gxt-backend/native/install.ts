// gxt NATIVE layer — the one place the native layer wires itself into gxt
// (design §2.2 `install.ts`). Imported for its side effect by native/renderer.ts
// (the module every Ember render path and the application registry load, the
// edge classic uses for its VM global context). Registers once; named imports
// only, so nothing else of gxt is retained.
import { registerHostHooks, registerHostManagers } from '@lifeart/gxt';
import { installRenderLoop, normalizeAttrValue, scheduleRevalidate, toBool } from './host-hooks';
import { helperManager } from './helper-manager';
import { componentManager, resolveComponentName } from './managers';
import { modifierManager } from './modifier-manager';
import { Outlet } from './outlet';

let installed = false;

export function install(): void {
  if (installed) return;
  installed = true;
  registerHostHooks({
    scheduleRevalidate,
    toBool,
    normalizeAttrValue,
    resolveComponentName,
    // `{{outlet}}` (G3: compiled to `$_outlet(ctx)` under NATIVE_FLAGS.EMBER_OUTLET)
    outletComponent: Outlet,
  });
  registerHostManagers({
    component: componentManager as never,
    helper: helperManager as never,
    modifier: modifierManager as never,
  });
  installRenderLoop();
}

install();
