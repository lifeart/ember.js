// The GXT side of glimmer's renderer modules: installs the glimmer host
// (gxt-bridge `setGxtGlimmerHost`) that glimmer's templates/root.ts calls in
// GXT builds, and loads the modules that install their gxt-bridge parts.
// compile.ts imports this module, so all of it is installed before a renderer
// is created.
import { setGxtGlimmerHost } from './gxt-bridge';
import { createRootTemplate } from './root-template';
// Installs the force re-render of the classic roots (gxt-bridge parts).
import './classic-roots';

setGxtGlimmerHost({ createRootTemplate });
