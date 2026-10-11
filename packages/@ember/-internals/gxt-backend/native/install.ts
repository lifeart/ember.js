// gxt NATIVE layer — the one place the native layer wires itself into gxt
// (design §2.2 `install.ts`). Imported for its side effect by native/renderer.ts
// (the module every Ember render path and the application registry load, the
// edge classic uses for its VM global context). Registers once; named imports
// only, so nothing else of gxt is retained.
import { registerHostHooks, registerHostManagers } from '@lifeart/gxt';
import { installRenderLoop, normalizeAttrValue, scheduleRevalidate, toBool } from './host-hooks';
import { componentManager, resolveComponentName } from './managers';

let installed = false;

export function install(): void {
  if (installed) return;
  installed = true;
  registerHostHooks({
    scheduleRevalidate,
    toBool,
    normalizeAttrValue,
    resolveComponentName,
  });
  registerHostManagers({ component: componentManager as never });
  installRenderLoop();
}

install();
