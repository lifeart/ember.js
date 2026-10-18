import '@glimmer/manager';
// The import above is side-effect only: the GXT root template that moved to
// gxt-backend/root-template.ts imported from it, and the builds keep their
// module graph (the gxt-native build's cycle check follows its order).
// Classic-build template compiler (build-time macro in classic pipelines; the
// GXT-aliased shim in GXT mode, where the call site below is dead-branched).
import { precompileTemplate } from '@ember/template-compilation';
import { getGxtGlimmerHost } from '@ember/-internals/gxt-backend/gxt-bridge';

// The GXT root template, created by gxt-backend's glimmer host
// (gxt-backend/root-template.ts). The GXT `@ember/template-compilation`
// imported above installs the host when it loads.
function gxtRootTemplate(owner: object): unknown {
  const host = getGxtGlimmerHost();
  if (host === null) {
    throw new Error('[gxt] the glimmer host is not installed (gxt-backend/glimmer-host.ts)');
  }
  return host.createRootTemplate(owner);
}

// The classic root template, consumed by the Glimmer VM (setup-registry.ts
// registers it as `template:-root`). It is skipped in GXT builds so the
// GXT-aliased `@ember/template-compilation` shim is never invoked at
// module-init time; `__GXT_MODE__` is inlined at build time, so exactly one
// branch survives in each dist. The classic VM cannot run
// `createRootTemplate`'s fake compile handle.
const ClassicRootTemplate = __GXT_MODE__
  ? undefined
  : precompileTemplate(`{{component this}}`, {
      moduleName: 'packages/@ember/-internals/glimmer/lib/templates/root.hbs',
      strictMode: true,
    });

export default (__GXT_MODE__ ? gxtRootTemplate : ClassicRootTemplate) as any;
