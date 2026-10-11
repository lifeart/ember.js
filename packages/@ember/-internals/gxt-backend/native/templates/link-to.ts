// gxt NATIVE layer — alias target for
// `@ember/-internals/glimmer/lib/templates/link-to` (the reused classic LinkTo
// class imports it as its layout via InternalComponent's `opaquify`).
//
// Inc 6 replaces this with the AOT `templates/link-to.gts` rendered with
// `this` = the InternalComponent instance (design §2.2/§2.3). The placeholder
// is a callable so `setComponentTemplate` registration at module eval works.
import { notImplemented } from '../not-implemented';

export default function nativeLinkToTemplate(): never {
  notImplemented('native <LinkTo> template', 6);
}
