// krausest benchmark app built against a ROLLUP DIST snapshot of ember-source —
// the same from-dist pipeline as the modern app (smoke-tests/modern-app/
// vite.dist.config.mjs `distAppConfig`): classic = content-tag + wire-format
// precompile through the dist's ember-template-compiler; gxt-native = the gxt
// vite plugin under NATIVE_FLAGS. PRODUCTION mode, terser, hidden sourcemaps
// (the driver maps CPU profiles through them).
//
// Env: KRAUSEST_FLAVOR = classic | gxt-native, KRAUSEST_EMBER_DIST = the dist
// snapshot dir, KRAUSEST_OUT_DIR = output dir. Driven by
// `node scripts/krausest-bench.mjs build`.
//
// KRAUSEST_INPUT_SOURCEMAPS=1 (profiling builds): load the linked gxt dist's
// INLINE sourcemaps (a gxt `build-lib` with `--with-sourcemaps`) so the app's
// hidden sourcemap maps the minified gxt runtime back to glimmer-next source.
// Without it rollup maps a minified one-line gxt chunk to its line start only.
// The emitted code is identical either way (only the .map differs).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distAppConfig } from '../modern-app/vite.dist.config.mjs';
import { EMBER_ROOT } from '../modern-app/harness-shared.mjs';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const INLINE_MAP = /\n?\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/;

function gxtInputSourcemaps() {
  const gxtDist = join(realpathSync(join(EMBER_ROOT, 'node_modules/@lifeart/gxt')), 'dist');
  return {
    name: 'krausest-gxt-input-sourcemaps',
    enforce: 'pre',
    load(id) {
      if (!id.startsWith(gxtDist) || !id.endsWith('.js') || !existsSync(id)) return null;
      const code = readFileSync(id, 'utf8');
      const m = INLINE_MAP.exec(code);
      if (!m) {
        throw new Error(
          `KRAUSEST_INPUT_SOURCEMAPS: ${id} has no inline sourcemap (build gxt with --with-sourcemaps)`
        );
      }
      return {
        code: code.slice(0, m.index),
        map: JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')),
      };
    },
  };
}

export default ({ mode }) => {
  const flavor = process.env.KRAUSEST_FLAVOR;
  const outDir = process.env.KRAUSEST_OUT_DIR || resolve(APP_DIR, 'dist', flavor);
  const config = distAppConfig({
    mode,
    appDir: APP_DIR,
    input: resolve(APP_DIR, 'index.html'),
    outDir,
    statsDir: resolve(outDir, '..', `${basename(outDir)}-stats`),
    flavor,
    distDir: process.env.KRAUSEST_EMBER_DIST,
    include: [`${APP_DIR}/app/**`],
  });
  if (process.env.KRAUSEST_INPUT_SOURCEMAPS === '1') config.plugins.unshift(gxtInputSourcemaps());
  return config;
};
