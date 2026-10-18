// The GXT side of glimmer's renderer modules: installs the glimmer host
// (gxt-bridge `setGxtGlimmerHost`) that glimmer's templates/root.ts calls in
// GXT builds. compile.ts imports this module, so the host is installed before
// a renderer is created.
import { setGxtGlimmerHost } from './gxt-bridge';
import { createRootTemplate } from './root-template';

setGxtGlimmerHost({ createRootTemplate });
