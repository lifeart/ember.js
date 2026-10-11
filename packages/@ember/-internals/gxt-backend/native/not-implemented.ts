// gxt NATIVE layer (EMBER_RENDER_BACKEND=gxt-native) — shared failure helpers.
//
// Two kinds of "not here" exist in the native build, and they must read
// differently to whoever hits them:
//
//  - notImplemented(): an Inc-1 skeleton placeholder. The real implementation
//    lands in the named increment of docs-internal-gxt-native-layer-design.md §5.
//    The message format `<what>: not implemented (Inc N)` is what the
//    modern-app boot check greps for.
//  - documentedDrop(): a LEGACY surface that the native build deliberately does
//    not support (design §2.5 / goal scope "LEGACY (OUT)"). Not a TODO.

export function notImplemented(what: string, inc: number | string): never {
  throw new Error(`${what}: not implemented (Inc ${inc})`);
}

export function documentedDrop(what: string, instead: string): never {
  throw new Error(
    `${what} is not supported by the gxt-native build (documented legacy drop). ${instead}`
  );
}
