// Consumer app of the packed gxt-native Ember package — the app a user writes:
// the package's Vite preset plus their own babel for decorators. Build options
// and app babel mirror the from-dist harness
// (smoke-tests/modern-app/vite.dist.config.mjs) so the bytes compare with what
// `node scripts/bundle-modern-app.mjs --from-dist` measured.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { babel } from '@rollup/plugin-babel';
import { emberGxtNative } from 'ember-source/vite';

// ember.js config/targets.cjs with EMBER_ENV=production (the harness's targets)
const browsers = [
  'Chrome >= 109',
  'Edge >= 128',
  'Firefox >= 115',
  'iOS >= 15.6',
  'Safari >= 15.6',
  'ChromeAndroid >= 130',
  'FirefoxAndroid >= 130',
];

export default defineConfig({
  publicDir: false,
  base: './',
  logLevel: 'warn',
  esbuild: false,
  plugins: [
    emberGxtNative(),
    babel({
      babelHelpers: 'bundled',
      extensions: ['.js', '.gjs'],
      include: [fileURLToPath(new URL('./app/**', import.meta.url))],
      configFile: false,
      babelrc: false,
      presets: [['@babel/preset-env', { targets: { browsers } }]],
      plugins: [
        ['module:decorator-transforms', { runtime: { import: 'decorator-transforms/runtime' } }],
      ],
    }),
  ],
  build: {
    outDir: process.env.CONSUMER_OUT_DIR || 'dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: 'terser',
    sourcemap: 'hidden',
    manifest: true,
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rollupOptions: { input: process.env.CONSUMER_INPUT || 'index.html' },
  },
});
