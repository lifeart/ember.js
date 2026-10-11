// gxt NATIVE layer — alias target for
// `@ember/-internals/glimmer/lib/setup-registry` (called by @ember/application
// and @ember/engine). Registers the native renderer / outlet view instead of the
// classic VM ones; NO `service:-dom-builder` (VM tree builders) and NO
// `template:-root` (the native renderer renders the outlet directly).
//
// `component:link-to` is the REUSED classic LinkTo class (its InternalComponent
// base runs on native manager-api / reference / validator; its layout is the
// native link-to template, Inc 6). `component:input` / `component:textarea` are
// documented-drop stubs, registered so resolver lookups fail with the drop
// message.
import type Registry from '@ember/-internals/container/lib/registry';
import LinkTo from '@ember/-internals/glimmer/lib/components/link-to';
import OutletView from './outlet';
import { Renderer } from './renderer';
import Input from './stubs/input';
import Textarea from './stubs/textarea';
import { placeholderTemplateFactory } from './template-factory';

// `template:-outlet`: a TemplateFactory (`factory(owner) -> template`) — the
// router hands it to `OutletView.create`, and route.ts invokes it for routes
// without a template. Inc 4b replaces it with the native Outlet component.
const nativeOutletTemplate = placeholderTemplateFactory('native outlet template', '4b');

export function setupApplicationRegistry(registry: Registry): void {
  registry.register('renderer:-dom', Renderer);
}

export function setupEngineRegistry(registry: Registry): void {
  registry.optionsForType('template', { instantiate: false });

  registry.register('view:-outlet', OutletView);
  registry.register('template:-outlet', nativeOutletTemplate as any);

  registry.optionsForType('helper', { instantiate: false });

  registry.register('component:input', Input);
  registry.register('component:link-to', LinkTo);
  registry.register('component:textarea', Textarea);
}
