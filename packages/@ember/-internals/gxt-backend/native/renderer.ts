// gxt NATIVE layer — alias target for `@ember/-internals/glimmer/lib/renderer`
// (the classic VM renderer + its `@glimmer/runtime` / opcode-compiler / program
// residue: P0a lever L4, never imported in native).
//
// INC-1 SKELETON: every rendering entry point throws
// `native renderer: not implemented (Inc 4)`. Inc 4 implements (design §2.2):
//   Renderer          appendOutletView / appendTo via gxt renderComponent into a
//                     createRoot with OWNER context, rerender = gxt syncDom,
//                     destroy, debugRenderTree.capture() → captureRenderTree
//   renderSettled     backburner `end` + pending flag (no 16 ms pump)
//   renderComponent   gxt renderComponent(component, {into, owner, args})
// Construction (registry `renderer:-dom` lookups) and destroy() stay safe so
// container setup / teardown never fails before the first real render call.
import { installHostHooks } from './host-hooks';
import { notImplemented } from './not-implemented';

// Classic installs the VM global context (scheduleRevalidate etc.) from
// environment.ts, which the classic renderer imports; the native renderer is
// the same always-loaded edge for the gxt host hooks.
installHostHooks();

const WHAT = 'native renderer';

export class Renderer {
  static create(props: { _viewRegistry?: unknown } = {}): Renderer {
    return new Renderer(props._viewRegistry);
  }

  constructor(readonly _viewRegistry?: unknown) {}

  appendOutletView(_view: unknown, _target: unknown): never {
    notImplemented(WHAT, 4);
  }

  appendTo(_view: unknown, _target: unknown): never {
    notImplemented(WHAT, 4);
  }

  rerender(): never {
    notImplemented(WHAT, 4);
  }

  register(_view: unknown): never {
    notImplemented(WHAT, 4);
  }

  unregister(_view: unknown): never {
    notImplemented(WHAT, 4);
  }

  remove(_view: unknown): never {
    notImplemented(WHAT, 4);
  }

  getElement(_view: unknown): never {
    notImplemented(WHAT, 4);
  }

  getBounds(_view: unknown): never {
    notImplemented(WHAT, 4);
  }

  get debugRenderTree(): never {
    return notImplemented(`${WHAT} debugRenderTree`, 9);
  }

  destroy(): void {
    // nothing rendered yet (Inc 4 tears down the gxt roots here)
  }
}

export function renderSettled(): never {
  notImplemented(`${WHAT} renderSettled`, 4);
}

export function renderComponent(_component: unknown, _options?: unknown): never {
  notImplemented(`${WHAT} renderComponent`, 4);
}

export function _resetRenderers(): void {
  // no renderer registry until Inc 4
}
