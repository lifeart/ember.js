// The GXT side of glimmer's renderer modules: installs the glimmer host
// (gxt-bridge `setGxtGlimmerHost`) that glimmer's base-renderer.ts, renderer.ts
// and templates/root.ts call in GXT builds, and loads the modules that install
// their gxt-bridge parts. compile.ts imports this module, so all of it is
// installed before a renderer is created.
import { setGxtGlimmerHost } from './gxt-bridge';
import { createRootTemplate } from './root-template';
import { _renderComponentGxt, gxtDebugRenderTree } from './render-component';
// Also installs the force re-render of the classic roots (gxt-bridge parts).
import { componentBounds, destroyClassicRoot, renderClassicRoot } from './classic-roots';

setGxtGlimmerHost({
  createRootTemplate,
  renderComponent: _renderComponentGxt,
  debugRenderTree: gxtDebugRenderTree,
  renderClassicRoot,
  destroyClassicRoot,
  componentBounds,
});
