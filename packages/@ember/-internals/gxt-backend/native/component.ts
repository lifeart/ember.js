// gxt NATIVE layer — alias target for the `@ember/component` BARREL (exact
// specifier only; `@ember/component/helper` and `/template-only` stay classic).
//
// Why a native barrel: `@glimmer/component` imports `setComponentManager` and
// `capabilities` from `@ember/component`, and the classic barrel's default
// export drags the whole classic Component / CoreView / curly manager /
// TargetActionSupport subtree into every app (P0a lever L8, −3.1 KB br). Editing
// the shared `@glimmer/component` source would also move the classic bar, so the
// cut happens here (design §2.2/§4). Same export names as the classic barrel,
// plus `templateOnly` (design §2.2).
export { setComponentTemplate, getComponentTemplate } from './manager-api';
export { componentCapabilities as capabilities } from './manager-api';
export { setComponentManager } from '@ember/-internals/glimmer/lib/utils/managers';
export { templateOnlyComponent as templateOnly } from './template-only';
export { default } from './stubs/component';
export { default as Input } from './stubs/input';
export { default as Textarea } from './stubs/textarea';
