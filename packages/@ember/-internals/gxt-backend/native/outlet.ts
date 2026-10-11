// gxt NATIVE layer — alias target for
// `@ember/-internals/glimmer/lib/views/outlet` (registered as `view:-outlet`).
//
// INC-1 SKELETON with the classic OutletView contract the router relies on
// (`factoryFor('view:-outlet').create({environment, template, application})`,
// `setOutletState(root)`, `appendTo(rootElement)` → schedules
// `renderer.appendOutletView` in the `render` queue, `destroy()`), so a native
// app boots all the way to the renderer stub. Inc 4 (design §2.2 outlet.ts):
// the state becomes a gxt cell (`setOutletState` = dirty) and the `Outlet`
// component reads the parent OUTLET context → `outlets.main` and renders
// `render.template` via gxt `$_dc` with `@model`/`@controller` (G3 EMBER_OUTLET).
import { type InternalOwner, getOwner } from '@ember/-internals/owner';
import { assert } from '@ember/debug';
import { schedule } from '@ember/runloop';
import type { Renderer } from './renderer';

export interface BootEnvironment {
  hasDOM: boolean;
  isInteractive: boolean;
  _renderMode?: string;
  options: unknown;
}

interface OutletState {
  outlets: { main: OutletState | undefined };
  render: Record<string, unknown> | undefined;
}

const TOP_LEVEL_NAME = '-top-level';

export default class OutletView {
  static extend(injections: object): typeof OutletView {
    return class extends OutletView {
      static create(options: any) {
        return super.create(options ? Object.assign({}, injections, options) : injections);
      }
    };
  }

  static reopenClass(injections: object): void {
    Object.assign(this, injections);
  }

  static create(options: {
    environment: BootEnvironment;
    application: InternalOwner;
    template: unknown;
  }): OutletView {
    const owner = getOwner(options);
    assert('OutletView is unexpectedly missing an owner', owner);
    return new OutletView(options.environment, owner, options.template, options.application);
  }

  readonly state: OutletState;

  constructor(
    private _environment: BootEnvironment,
    public owner: InternalOwner,
    public template: unknown,
    public namespace: unknown
  ) {
    this.state = {
      outlets: { main: undefined },
      render: { owner, name: TOP_LEVEL_NAME, controller: undefined, model: undefined, template },
    };
  }

  appendTo(selector: string | Element): void {
    const target =
      this._environment.hasDOM && typeof selector === 'string'
        ? document.querySelector(selector)
        : selector;
    const renderer = this.owner.lookup('renderer:-dom') as Renderer;
    schedule('render', renderer, 'appendOutletView', this, target);
  }

  rerender(): void {
    // re-render is driven by the renderer (Inc 4)
  }

  setOutletState(state: OutletState): void {
    this.state.outlets.main = state;
  }

  destroy(): void {
    // nothing rendered yet (Inc 4 tears down the outlet root here)
  }
}
