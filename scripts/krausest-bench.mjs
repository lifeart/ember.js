#!/usr/bin/env node
// scripts/krausest-bench.mjs — krausest (js-framework-benchmark, keyed) driver for
// smoke-tests/krausest-app built against the ROLLUP DISTS of ember-source:
// classic Glimmer VM vs gxt-native, both PRODUCTION builds through the same
// from-dist vite pipeline (smoke-tests/modern-app/vite.dist.config.mjs).
//
// Subcommands (repo root; ONE browser at a time; wrap every call in a hard
// timeout, e.g. `perl -e 'alarm shift; exec @ARGV' 1800 node scripts/krausest-bench.mjs …`):
//
//   build   [--variant <label>[=<flavor>[:<distSnapshotDir>]]]… [--input-sourcemaps]
//           vite-builds the app per variant into smoke-tests/krausest-app/dist/<label>
//           and prints boot-JS raw/gzip/brotli. Default variants: classic and
//           gxt-native from the snapshots `node scripts/bundle-modern-app.mjs
//           --from-dist --build-dists` leaves in smoke-tests/modern-app/dist/ember-dist/.
//   bench   --variants a,b[,…] [--reps 10] [--rows inline|component|if] [--json out.json]
//           the 9 krausest ops (`--rows if`: the `{{#if}}` micro-benchmark ops, IF_OPS), every variant once per rep in a FRESH page, variants
//           interleaved (order alternates per rep). Per op: krausest warmups, gc(),
//           krausest CPU slowdown on the measured op, `script` = click → end of
//           the run loop it starts (20 microtask ticks; backburner's autorun ends
//           at the 3rd), `total` = + a forced style/layout. Every
//           measured op is CORRECTNESS-checked (row count / ids / labels / selection
//           invariants + row structure; DOM work deferred past the run loop fails) and its DOM digest must equal the first
//           variant's (the oracle) in the same rep — a win by under-rendering fails.
//           Also: boot marks per page load and the JS heap with 10k rows.
//   boot    --variants a,b [--app krausest|modern] [--reps 20] [--cpu 1] [--json out]
//           page loads only: navigation → js-start (krausest app) → first render →
//           first idle; FCP. `--app modern` loads smoke-tests/modern-app/dist/<variant>.
//   profile --variant v [--ops create1k,update10th,…] [--iters 5] [--rows …] --out dir
//           CDP CPU profiles of the measured ops (after the same warmups), saved
//           as .cpuprofile; JS self time attributed through the bundle's hidden
//           sourcemap to buckets: app / native-layer / gxt / ember-metal /
//           backburner / glimmer-vm / … (written to <out>/<variant>-attribution.json).
//           For gxt function-level attribution build the variant with
//           `--input-sourcemaps` against a gxt dist built with inline sourcemaps.
/* global window, document, MutationObserver, requestIdleCallback */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const EMBER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(EMBER_ROOT, 'smoke-tests/krausest-app');
const DIST_ROOT = join(APP_DIR, 'dist');
const MODERN_DIST_ROOT = join(EMBER_ROOT, 'smoke-tests/modern-app/dist');
const SNAPSHOT_ROOT = join(MODERN_DIST_ROOT, 'ember-dist');
const VITE_BIN = join(EMBER_ROOT, 'node_modules/.bin/vite');

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const opts = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const log = (msg) => process.stdout.write(`[krausest] ${msg}\n`);

// ---------------------------------------------------------------- build
function parseVariant(spec) {
  const [label, rest] = spec.split('=');
  const [flavor, dist] = (rest ?? label).split(':');
  return { label, flavor, dist: dist ?? join(SNAPSHOT_ROOT, flavor) };
}

function bootFiles(dir) {
  const stats = JSON.parse(readFileSync(join(`${dir}-stats`, 'bundle-stats.json'), 'utf8'));
  const byName = new Map(stats.chunks.map((c) => [c.fileName, c]));
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const roots = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\.?\/?([^"]+)"/g)].map(
    (m) => m[1]
  );
  const boot = new Set();
  const visit = (name) => {
    if (boot.has(name)) return;
    boot.add(name);
    for (const dep of byName.get(name)?.imports ?? []) visit(dep);
  };
  roots.forEach(visit);
  return [...boot];
}

function sizesOf(dir) {
  const total = { raw: 0, gz: 0, br: 0, files: 0 };
  for (const file of bootFiles(dir)) {
    const buf = readFileSync(join(dir, file));
    total.raw += buf.byteLength;
    total.gz += gzipSync(buf).byteLength;
    total.br += brotliCompressSync(buf).byteLength;
    total.files++;
  }
  return total;
}

function build() {
  const specs = opts('--variant');
  const variants = (specs.length ? specs : ['classic', 'gxt-native']).map(parseVariant);
  const rows = [];
  for (const { label, flavor, dist } of variants) {
    const outDir = join(DIST_ROOT, label);
    const env = {
      ...process.env,
      EMBER_ENV: 'production',
      KRAUSEST_FLAVOR: flavor,
      KRAUSEST_EMBER_DIST: dist,
      KRAUSEST_OUT_DIR: outDir,
    };
    if (argv.includes('--input-sourcemaps')) env.KRAUSEST_INPUT_SOURCEMAPS = '1';
    delete env.GXT_MODE;
    delete env.EMBER_RENDER_BACKEND;
    mkdirSync(DIST_ROOT, { recursive: true });
    const logFile = join(DIST_ROOT, `${label}-build.log`);
    const t0 = Date.now();
    const r = spawnSync(
      VITE_BIN,
      ['build', '--config', join(APP_DIR, 'vite.config.mjs'), '--mode', 'production'],
      { cwd: EMBER_ROOT, env, encoding: 'utf8', timeout: 900_000, maxBuffer: 256 << 20 }
    );
    writeFileSync(logFile, `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
    if (r.error || r.status !== 0) {
      throw new Error(`${label} build failed (status ${r.status}); see ${logFile}`);
    }
    const s = sizesOf(outDir);
    log(
      `built ${label} (${flavor}, ${relative(EMBER_ROOT, dist)}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    rows.push({ label, flavor, dist: relative(EMBER_ROOT, dist), ...s });
  }
  console.log('\n| variant | flavor | files | raw | gzip | brotli |\n|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.flavor} | ${r.files} | ${r.raw.toLocaleString('en')} | ${r.gz.toLocaleString('en')} | ${r.br.toLocaleString('en')} |`
    );
  }
  const json = opt('--json', null);
  if (json) writeFileSync(json, JSON.stringify(rows, null, 1));
}

// ---------------------------------------------------------------- server
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};
// /k/<label>/… → krausest-app dist; /m/<label>/… → modern-app dist
async function startServer() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    const m = /^\/([km])\/([^/]+)\/(.*)$/.exec(path);
    const root = m ? join(m[1] === 'k' ? DIST_ROOT : MODERN_DIST_ROOT, m[2]) : null;
    const file = root ? join(root, m[3] === '' ? 'index.html' : m[3]) : null;
    if (file && file.startsWith(root + sep) && existsSync(file)) {
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(file));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function launch() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--js-flags=--expose-gc',
    ],
  });
}

// ---------------------------------------------------------------- in-page kit
// Installed before any page script: boot marks + the op helpers.
function pageKit(firstRenderSelector) {
  const mo = new MutationObserver(() => {
    if (document.querySelector(firstRenderSelector)) {
      mo.disconnect();
      performance.mark('first-render');
      requestIdleCallback(() => performance.mark('first-idle'));
    }
  });
  mo.observe(document, { childList: true, subtree: true });
  const TB = 'table.test-data tbody';
  const kb = (window.__kb = {});
  kb.rows = () => document.querySelectorAll(`${TB} > tr`);
  kb.sel = (t) => {
    const [kind, n] = t.split(':');
    return n ? `${TB} > tr:nth-child(${n}) a[data-test-${kind}]` : t;
  };
  kb.el = (t) => {
    const el = document.querySelector(kb.sel(t));
    if (!el) throw new Error(`missing ${kb.sel(t)}`);
    return el;
  };
  kb.settle = () => new Promise((r) => setTimeout(r, 0));
  kb.steps = async (targets) => {
    for (const t of targets) {
      kb.el(t).click();
      await kb.settle();
    }
  };
  // script = click → end of the (auto)run loop it starts. Both flavors render in
  // that run loop: backburner's autorun flushes a few microtask ticks after the
  // click's tracked write (measured: the DOM is final at the 3rd tick in both),
  // so 20 microtask ticks (sub-microsecond each) end after it. total = + a
  // forced style + layout. The DOM at that point must already be final: its
  // digest is compared with the digest after a full settle (setTimeout) — DOM
  // work deferred past the run loop marks the op invalid.
  kb.measure = async (t) => {
    const el = kb.el(t);
    const t0 = performance.now();
    el.click();
    for (let i = 0; i < 20; i++) await null;
    const t1 = performance.now();
    void document.querySelector('table.test-data').offsetHeight;
    const t2 = performance.now();
    const early = kb.digest();
    await kb.settle();
    return { script: t1 - t0, total: t2 - t0, deferred: early !== kb.digest() };
  };
  // profile mode: the click and its run loop only (no layout, no digest)
  kb.measureScript = async (t) => {
    const el = kb.el(t);
    const t0 = performance.now();
    el.click();
    for (let i = 0; i < 20; i++) await null;
    return { script: performance.now() - t0, total: NaN, deferred: false };
  };
  kb.state = () =>
    [...kb.rows()].map((tr) => {
      const cells = tr.children;
      return [
        cells[0]?.textContent.trim() ?? '',
        cells[1]?.textContent.trim() ?? '',
        tr.className.trim(),
        cells.length,
        Boolean(tr.querySelector('td.col-md-4 > a[data-test-select]')) &&
          Boolean(tr.querySelector('td.col-md-1 > a[data-test-remove] > span.glyphicon-remove')),
      ];
    });
  // `?rows=if`: [id, label, has the select anchor, has the remove anchor, cell count]
  kb.ifState = () =>
    [...kb.rows()].map((tr) => {
      const cells = tr.children;
      return [
        cells[0]?.textContent.trim() ?? '',
        cells[1]?.textContent.trim() ?? '',
        Boolean(tr.querySelector('td.col-md-4 > a[data-test-select]')),
        Boolean(tr.querySelector('td.col-md-1 > a[data-test-remove] > span.glyphicon-remove')),
        cells.length,
      ];
    });
  // Canonical row markup: sorted attributes, comments and whitespace-only text
  // dropped, whitespace runs collapsed. An empty `class` counts as absent: Glimmer removes the attribute
  // for a falsy `class={{if …}}`, gxt-native leaves `class=""` (a reported parity
  // nit, not a rendering difference).
  const canon = (node) => {
    if (node.nodeType === 3) return node.nodeValue.trim() === '' ? '' : node.nodeValue;
    if (node.nodeType !== 1) return '';
    const attrs = [...node.attributes]
      .filter((a) => !(a.name === 'class' && a.value === ''))
      .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
      .sort()
      .join(' ');
    return `<${node.tagName} ${attrs}>${[...node.childNodes].map(canon).join('')}</>`;
  };
  kb.digest = () => {
    let h = 0x811c9dc5;
    for (const tr of kb.rows()) {
      const line = `${canon(tr).replace(/\s+/g, ' ')}\n`;
      for (let i = 0; i < line.length; i++) {
        h ^= line.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
    }
    return `${(h >>> 0).toString(16)}:${kb.rows().length}`;
  };
  kb.emptyClassRows = () => [...kb.rows()].filter((tr) => tr.getAttribute('class') === '').length;
}

// ---------------------------------------------------------------- ops
// krausest benchmark definitions (js-framework-benchmark keyed): warmups,
// CPU slowdown, the measured click and its correctness check over the
// [id, label, class, cellCount, anchorsOk] row states before/after.
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const ids = (state) => state.map((r) => Number(r[0]));
function consecutive(state, from) {
  return state.every((r, i) => Number(r[0]) === from + i);
}
const maxId = (state) => state.reduce((m, r) => Math.max(m, Number(r[0])), 0);

const OPS = {
  create1k: {
    cpu: 1,
    again: ['#clear'],
    warm: range(5, () => ['#run', '#clear']).flat(),
    target: '#run',
    check: (pre, post) =>
      post.length === 1000 &&
      consecutive(post, Number(post[0][0])) &&
      (pre.length === 0 || Number(post[0][0]) === maxId(pre) + 1),
  },
  replace1k: {
    cpu: 1,
    warm: range(5, () => '#run'),
    target: '#run',
    check: (pre, post) => post.length === 1000 && consecutive(post, maxId(pre) + 1),
  },
  update10th: {
    cpu: 4,
    setup: ['#run'],
    warm: range(3, () => '#update'),
    target: '#update',
    check: (pre, post) =>
      post.length === pre.length &&
      post.every(
        (r, i) => r[0] === pre[i][0] && r[1] === (i % 10 === 0 ? `${pre[i][1]} !!!` : pre[i][1])
      ),
  },
  select: {
    cpu: 4,
    again: ['select:5'],
    setup: ['#run'],
    warm: range(5, (i) => `select:${5 - i}`),
    target: 'select:2',
    check: (pre, post) =>
      post.length === pre.length &&
      post.every((r, i) => r[0] === pre[i][0] && r[2] === (i === 1 ? 'danger' : '')),
  },
  swap: {
    cpu: 4,
    setup: ['#run'],
    warm: range(5, () => '#swaprows'),
    target: '#swaprows',
    check: (pre, post) =>
      post.length === pre.length &&
      post.every((r, i) => r[0] === pre[i === 1 ? 998 : i === 998 ? 1 : i][0]),
  },
  remove: {
    cpu: 2,
    setup: ['#run'],
    warm: range(5, (i) => `remove:${10 - i}`),
    target: 'remove:4',
    check: (pre, post) => {
      const expected = ids(pre).filter((_, i) => i !== 3);
      return post.length === pre.length - 1 && ids(post).every((id, i) => id === expected[i]);
    },
  },
  create10k: {
    cpu: 1,
    again: ['#clear'],
    setup: ['#clear'],
    warm: range(5, () => ['#run', '#clear']).flat(),
    target: '#runlots',
    check: (pre, post) =>
      post.length === 10000 && consecutive(post, pre.length ? maxId(pre) + 1 : Number(post[0][0])),
  },
  append1k: {
    cpu: 1,
    again: ['#clear', '#run'],
    setup: ['#clear'],
    warm: [...range(5, () => ['#run', '#add']).flat(), '#run'],
    target: '#add',
    check: (pre, post) =>
      post.length === pre.length + 1000 &&
      pre.every((r, i) => post[i][0] === r[0]) &&
      consecutive(post.slice(pre.length), maxId(pre) + 1),
  },
  clear1k: {
    cpu: 4,
    again: ['#run'],
    setup: ['#clear'],
    warm: [...range(5, () => ['#run', '#clear']).flat(), '#run'],
    target: '#clear',
    check: (_pre, post) => post.length === 0,
  },
};

const structureOk = (state) =>
  state.every((r) => r[3] === 4 && r[4] === true && /^\d+$/.test(r[0]) && r[1].length > 0);

// `--rows if` (`?rows=if`, IfBench): every row's label cell is `{{#if
// showLabels}}` (one condition for all rows) and its remove cell `{{#if
// row.flag}}…{{else}}…{{/if}}` (one per row). States are `kb.ifState()`:
// [id, label, select anchor, remove anchor, cells].
const sameIds = (pre, post) =>
  post.length === pre.length && post.every((r, i) => r[0] === pre[i][0]);
const IF_OPS = {
  create1k: {
    cpu: 1,
    again: ['#clear'],
    warm: range(5, () => ['#run', '#clear']).flat(),
    target: '#run',
    check: (_pre, post) =>
      post.length === 1000 && post.every((r) => r[1].length > 0 && r[2] && r[3]),
  },
  hideAll: {
    cpu: 1,
    again: ['#togglelabels'],
    setup: ['#run'],
    warm: range(5, () => ['#togglelabels', '#togglelabels']).flat(),
    target: '#togglelabels',
    check: (pre, post) =>
      sameIds(pre, post) && post.every((r, i) => r[1] === '' && !r[2] && r[3] === pre[i][3]),
  },
  showAll: {
    cpu: 1,
    again: ['#togglelabels'],
    setup: ['#run'],
    warm: [...range(5, () => ['#togglelabels', '#togglelabels']).flat(), '#togglelabels'],
    target: '#togglelabels',
    check: (pre, post) =>
      sameIds(pre, post) &&
      pre.every((r) => r[1] === '') &&
      post.every((r, i) => r[1].length > 0 && r[2] && r[3] === pre[i][3]),
  },
  toggle10th: {
    cpu: 4,
    setup: ['#run'],
    warm: range(5, () => '#toggle10th'),
    target: '#toggle10th',
    check: (pre, post) =>
      sameIds(pre, post) &&
      post.every((r, i) => r[1] === pre[i][1] && r[3] === (i % 10 === 0 ? !pre[i][3] : pre[i][3])),
  },
  toggleOne: {
    cpu: 4,
    setup: ['#run'],
    warm: range(5, () => '#toggleone'),
    target: '#toggleone',
    check: (pre, post) =>
      sameIds(pre, post) && post.every((r, i) => r[3] === (i === 1 ? !pre[i][3] : pre[i][3])),
  },
  swap: {
    cpu: 4,
    setup: ['#run', '#toggle10th'],
    warm: range(5, () => '#swaprows'),
    target: '#swaprows',
    check: (pre, post) =>
      post.length === pre.length &&
      post.every((r, i) => {
        const from = pre[i === 1 ? 998 : i === 998 ? 1 : i];
        return r[0] === from[0] && r[1] === from[1] && r[3] === from[3];
      }),
  },
  remove: {
    cpu: 2,
    setup: ['#run'],
    warm: range(5, (i) => `remove:${10 - i}`),
    target: 'remove:4',
    check: (pre, post) => {
      const expected = ids(pre).filter((_, i) => i !== 3);
      return post.length === pre.length - 1 && ids(post).every((id, i) => id === expected[i]);
    },
  },
  clear1k: {
    cpu: 4,
    again: ['#run'],
    setup: ['#clear'],
    warm: [...range(5, () => ['#run', '#clear']).flat(), '#run'],
    target: '#clear',
    check: (_pre, post) => post.length === 0,
  },
};
const ifStructureOk = (state) => state.every((r) => r[4] === 4 && /^\d+$/.test(r[0]));

// Per `--rows` mode: the op table, the page's row-state function, the structure check.
const MODES = {
  inline: { ops: OPS, state: 'state', structure: structureOk },
  component: { ops: OPS, state: 'state', structure: structureOk },
  if: { ops: IF_OPS, state: 'ifState', structure: ifStructureOk },
};
function modeOf(rows) {
  const mode = MODES[rows];
  if (mode === undefined)
    throw new Error(`unknown --rows ${rows} (${Object.keys(MODES).join('|')})`);
  return mode;
}

async function openPage(browser, url, selector) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.addInitScript(pageKit, selector);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, errors };
}

async function bootMetrics(page) {
  await page.waitForFunction(() => performance.getEntriesByName('first-idle').length > 0, null, {
    timeout: 60_000,
  });
  return page.evaluate(() => {
    const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      responseEnd: nav?.responseEnd ?? null,
      jsStart: mark('js-start'),
      firstRender: mark('first-render'),
      firstIdle: mark('first-idle'),
      fcp: mark('first-contentful-paint'),
      dcl: nav?.domContentLoadedEventEnd ?? null,
    };
  });
}

const setCpu = (cdp, rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate });

// One fresh page: boot + every op. Returns { boot, ops: {name: {script,total,ok,digest,why}}, heap10k }.
async function runPage(browser, origin, label, rows, profile) {
  const mode = modeOf(rows);
  const query = rows === 'inline' ? '' : `?rows=${rows}`;
  const { context, page, cdp, errors } = await openPage(browser, `${origin}/k/${label}/`, '#run');
  const result = { label, ops: {}, errors };
  try {
    await page.goto(`${origin}/k/${label}/${query}`, { waitUntil: 'load', timeout: 60_000 });
    result.boot = await bootMetrics(page);
    if (profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: profile.interval });
    }
    for (const name of profile?.ops ?? Object.keys(mode.ops)) {
      const op = mode.ops[name];
      const iters = profile ? profile.iters : 1;
      for (let iter = 0; iter < iters; iter++) {
        // setup + warmups once; a repeated (profile) iteration first restores the
        // op's precondition (`again`: e.g. clear before create, re-select another row)
        const steps = iter === 0 ? [...(op.setup ?? []), ...op.warm] : (op.again ?? []);
        await page.evaluate((t) => window.__kb.steps(t), steps);
        const pre = await page.evaluate((fn) => window.__kb[fn](), mode.state);
        await page.evaluate(() => window.gc?.());
        if (op.cpu !== 1 && !profile) await setCpu(cdp, op.cpu);
        if (profile) await cdp.send('Profiler.start');
        let times;
        try {
          times = await page.evaluate(
            ([t, onlyScript]) =>
              onlyScript ? window.__kb.measureScript(t) : window.__kb.measure(t),
            [op.target, Boolean(profile)]
          );
        } finally {
          if (op.cpu !== 1 && !profile) await setCpu(cdp, 1);
        }
        if (profile) {
          const { profile: cpu } = await cdp.send('Profiler.stop');
          profile.collect(name, iter, cpu, times);
        }
        const post = await page.evaluate((fn) => window.__kb[fn](), mode.state);
        const digest = await page.evaluate(() => window.__kb.digest());
        const okCheck = op.check(pre, post);
        const okStructure = mode.structure(post);
        const why = [
          okCheck ? '' : 'check',
          okStructure ? '' : 'structure',
          times.deferred ? 'deferred-dom-work' : '',
          errors.length ? `errors: ${errors.slice(-2).join(' / ')}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        result.ops[name] = {
          script: times.script,
          total: times.total,
          ok: why === '',
          why,
          digest,
        };
        if (name === 'create10k' && !profile) {
          await page.evaluate(() => window.gc?.());
          const { usedSize } = await cdp.send('Runtime.getHeapUsage');
          result.heap10k = usedSize;
        }
      }
    }
  } catch (e) {
    result.fatal = String(e?.stack || e).slice(0, 2000);
  } finally {
    await context.close();
  }
  return result;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

async function bench() {
  const variants = opt('--variants', 'classic,gxt-native').split(',');
  const reps = Number(opt('--reps', '10'));
  const rows = opt('--rows', 'inline');
  const { server, origin } = await startServer();
  const browser = await launch();
  const runs = Object.fromEntries(variants.map((v) => [v, []]));
  const mismatches = [];
  try {
    for (let rep = 0; rep < reps; rep++) {
      const order = rep % 2 === 0 ? variants : [...variants].reverse();
      const byVariant = {};
      for (const v of order) {
        const r = await runPage(browser, origin, v, rows, null);
        byVariant[v] = r;
        runs[v].push(r);
        const bad = Object.entries(r.ops).filter(([, o]) => !o.ok);
        log(
          `rep ${rep + 1}/${reps} ${v}: ${r.fatal ? `FATAL ${r.fatal.split('\n')[0]}` : `${Object.keys(r.ops).length} ops, ${bad.length ? `INVALID ${bad.map(([n, o]) => `${n}(${o.why})`).join(', ')}` : 'all ok'}`}`
        );
      }
      // cross-variant DOM digest: the first variant is the oracle
      const oracle = byVariant[variants[0]];
      for (const v of variants.slice(1)) {
        for (const [name, o] of Object.entries(byVariant[v].ops)) {
          const ref = oracle.ops[name];
          if (ref && ref.digest !== o.digest) {
            o.ok = false;
            o.why = `${o.why} digest ${o.digest} != ${variants[0]} ${ref.digest}`.trim();
            mismatches.push({ rep, variant: v, op: name, digest: o.digest, oracle: ref.digest });
          }
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const summary = summarize(runs, variants, rows);
  printSummary(summary, variants, reps, rows);
  if (mismatches.length) log(`DIGEST MISMATCHES: ${JSON.stringify(mismatches.slice(0, 10))}`);
  const json = opt('--json', null);
  if (json)
    writeFileSync(
      json,
      JSON.stringify({ variants, reps, rows, summary, runs, mismatches }, null, 1)
    );
}

function summarize(runs, variants, rows = 'inline') {
  const out = {};
  for (const v of variants) {
    const ops = {};
    for (const name of Object.keys(modeOf(rows).ops)) {
      const samples = runs[v].map((r) => r.ops[name]).filter(Boolean);
      const okSamples = samples.filter((o) => o.ok);
      const script = okSamples.map((o) => o.script);
      const total = okSamples.map((o) => o.total);
      ops[name] = {
        n: okSamples.length,
        invalid: samples.length - okSamples.length,
        script: {
          median: median(script),
          p25: quantile(script, 0.25),
          p75: quantile(script, 0.75),
          min: Math.min(...script),
          max: Math.max(...script),
        },
        total: { median: median(total), p25: quantile(total, 0.25), p75: quantile(total, 0.75) },
      };
    }
    const boots = runs[v].map((r) => r.boot).filter(Boolean);
    const bootStat = (k) => median(boots.map((b) => b[k]).filter((x) => x !== null));
    out[v] = {
      ops,
      boot: {
        jsStart: bootStat('jsStart'),
        firstRender: bootStat('firstRender'),
        firstIdle: bootStat('firstIdle'),
        fcp: bootStat('fcp'),
      },
      heap10k: median(runs[v].map((r) => r.heap10k).filter(Boolean)),
      fatal: runs[v].filter((r) => r.fatal).length,
    };
  }
  return out;
}

function printSummary(summary, variants, reps, rows) {
  const [a, ...rest] = variants;
  console.log(
    `\nkrausest (${rows} rows), ${reps} reps, median ms [p25–p75] (script = click → end of its run loop; total = + forced style/layout)\n`
  );
  const head = [
    'op',
    'cpu',
    ...variants.map((v) => `${v} script`),
    ...rest.map((v) => `${v} Δ vs ${a}`),
    ...variants.map((v) => `${v} total`),
    'n ok',
  ];
  console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
  const modeOps = modeOf(rows).ops;
  for (const name of Object.keys(modeOps)) {
    const cells = [name, `${modeOps[name].cpu}x`];
    for (const v of variants) {
      const s = summary[v].ops[name].script;
      cells.push(`${fmt(s.median)} [${fmt(s.p25)}–${fmt(s.p75)}]`);
    }
    for (const v of rest) {
      const base = summary[a].ops[name].script.median;
      const val = summary[v].ops[name].script.median;
      cells.push(`${val >= base ? '+' : ''}${fmt(((val - base) / base) * 100, 1)}%`);
    }
    for (const v of variants) cells.push(fmt(summary[v].ops[name].total.median));
    cells.push(
      variants
        .map(
          (v) =>
            `${summary[v].ops[name].n}/${summary[v].ops[name].n + summary[v].ops[name].invalid}`
        )
        .join(' · ')
    );
    console.log(`| ${cells.join(' | ')} |`);
  }
  console.log(
    '\n| boot (median ms from navigation start) | ' +
      variants.join(' | ') +
      ' |\n|---|' +
      variants.map(() => '---').join('|') +
      '|'
  );
  for (const k of ['jsStart', 'firstRender', 'firstIdle', 'fcp']) {
    console.log(`| ${k} | ${variants.map((v) => fmt(summary[v].boot[k], 1)).join(' | ')} |`);
  }
  console.log(
    `| JS heap with 10k rows (MB) | ${variants.map((v) => fmt(summary[v].heap10k / 1e6, 1)).join(' | ')} |`
  );
  for (const v of variants) if (summary[v].fatal) log(`${v}: ${summary[v].fatal} FATAL page runs`);
}

// ---------------------------------------------------------------- boot
async function boot() {
  const variants = opt('--variants', 'classic,gxt-native').split(',');
  const app = opt('--app', 'krausest');
  const reps = Number(opt('--reps', '20'));
  const cpu = Number(opt('--cpu', '1'));
  const prefix = app === 'modern' ? 'm' : 'k';
  const selector = app === 'modern' ? '[data-test-title]' : '#run';
  const { server, origin } = await startServer();
  const browser = await launch();
  const runs = Object.fromEntries(variants.map((v) => [v, []]));
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (const v of rep % 2 === 0 ? variants : [...variants].reverse()) {
        const { context, page, cdp, errors } = await openPage(browser, '', selector);
        try {
          if (cpu !== 1) await setCpu(cdp, cpu);
          await page.goto(`${origin}/${prefix}/${v}/`, { waitUntil: 'load', timeout: 60_000 });
          const m = await bootMetrics(page);
          if (errors.length) m.errors = errors;
          runs[v].push(m);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(
    `\nboot (${app} app, ${reps} loads each, CPU ${cpu}x) — median [p25–p75] ms from navigation start\n`
  );
  console.log(`| metric | ${variants.join(' | ')} |\n|---|${variants.map(() => '---').join('|')}|`);
  for (const k of ['responseEnd', 'jsStart', 'firstRender', 'firstIdle', 'fcp']) {
    const cells = variants.map((v) => {
      const xs = runs[v].map((r) => r[k]).filter((x) => x !== null && x !== undefined);
      return xs.length
        ? `${fmt(median(xs), 1)} [${fmt(quantile(xs, 0.25), 1)}–${fmt(quantile(xs, 0.75), 1)}]`
        : 'n/a';
    });
    console.log(`| ${k} | ${cells.join(' | ')} |`);
  }
  // only loads that recorded both marks (the modern app has no js-start mark)
  const derived = (v, f) =>
    median(runs[v].filter((r) => r.jsStart !== null && r.jsStart !== undefined).map(f));
  console.log(
    `| firstRender − jsStart (evaluate + boot + render) | ${variants
      .map((v) =>
        fmt(
          derived(v, (r) => r.firstRender - r.jsStart),
          1
        )
      )
      .join(' | ')} |`
  );
  console.log(
    `| jsStart − responseEnd (script load + parse/compile) | ${variants
      .map((v) =>
        fmt(
          derived(v, (r) => r.jsStart - r.responseEnd),
          1
        )
      )
      .join(' | ')} |`
  );
  for (const v of variants) {
    const errs = runs[v].filter((r) => r.errors);
    if (errs.length) log(`${v}: page errors in ${errs.length} loads: ${errs[0].errors[0]}`);
  }
  const json = opt('--json', null);
  if (json) writeFileSync(json, JSON.stringify({ app, cpu, reps, variants, runs }, null, 1));
}

// ---------------------------------------------------------------- sourcemaps
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64MAP = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64MAP[B64.charCodeAt(i)] = i;

// Per generated line: sorted [genCol, srcIdx, srcLine, srcCol, nameIdx] segments.
function decodeMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;
  for (const lineStr of mappings.split(';')) {
    const segs = [];
    let genCol = 0;
    let i = 0;
    while (i < lineStr.length) {
      const fields = [];
      while (i < lineStr.length && lineStr[i] !== ',') {
        let value = 0;
        let shift = 0;
        let digit;
        do {
          digit = B64MAP[lineStr.charCodeAt(i++)];
          value += (digit & 31) << shift;
          shift += 5;
        } while (digit & 32);
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
      }
      i++;
      genCol += fields[0];
      if (fields.length >= 4) {
        srcIdx += fields[1];
        srcLine += fields[2];
        srcCol += fields[3];
        if (fields.length >= 5) nameIdx += fields[4];
        segs.push([genCol, srcIdx, srcLine, srcCol, fields.length >= 5 ? nameIdx : -1]);
      } else {
        segs.push([genCol, -1, 0, 0, -1]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

function makeLookup(map, mapDir) {
  const lines = decodeMappings(map.mappings);
  const sources = map.sources.map((s) => resolve(mapDir, map.sourceRoot ?? '', s));
  return (line, col) => {
    const segs = lines[line];
    if (!segs || segs.length === 0) return null;
    let lo = 0;
    let hi = segs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid][0] <= col) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0 || segs[best][1] < 0) return null;
    const s = segs[best];
    return {
      source: sources[s[1]],
      line: s[2],
      col: s[3],
      name: s[4] >= 0 ? map.names[s[4]] : null,
    };
  };
}

const distManifests = new Map();
function nativeManifest(distRoot) {
  if (!distManifests.has(distRoot)) {
    const p = join(distRoot, 'prod/gxt-native-manifest.json');
    distManifests.set(distRoot, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  }
  return distManifests.get(distRoot);
}

// Ember dist file → the source modules it bundles (native manifest), else the
// dist path itself (classic: rollup names chunks after their first module).
function bucketOf(source) {
  if (!source) return 'unmapped';
  const rel = relative(EMBER_ROOT, source).split(sep).join('/');
  if (/@lifeart\/gxt|glimmer-next/.test(source) || rel.includes('/gxt/dist/')) return 'gxt';
  if (rel.startsWith('smoke-tests/krausest-app/app/')) return 'app';
  if (/decorator-transforms/.test(rel)) return 'app';
  const m = /ember-dist\/([^/]+)\/prod\/(packages\/.+)$/.exec(rel);
  if (!m) return `other:${rel.split('/').slice(-2).join('/')}`;
  const [, flavor, distPath] = m;
  const manifest = nativeManifest(join(SNAPSHOT_ROOT, flavor));
  const modules = manifest?.chunks[distPath]
    ? Object.keys(manifest.chunks[distPath].modules)
    : [distPath];
  const kinds = new Set(modules.map(classifyModule));
  return kinds.size === 1 ? [...kinds][0] : [...kinds].sort().join('+');
}

function classifyModule(p) {
  if (p.includes('gxt-backend/native/')) return 'native-layer';
  if (p.includes('gxt-backend/')) return 'gxt-backend-other';
  if (/backburner/.test(p)) return 'backburner';
  if (/@ember\/runloop/.test(p)) return 'backburner';
  if (
    /@ember\/-internals\/metal|shared-chunks\/(alias|computed|meta|property_get|property_set|property_events|tracked|cached|decorator|array|observers|events|tags)-/.test(
      p
    )
  )
    return 'ember-metal';
  if (
    /@glimmer\/(validator|reference|destroyable|manager)|shared-chunks\/(cache|reference|iterable|tracking|args-proxy|capabilities|api)-/.test(
      p
    )
  )
    return 'glimmer-validator/reference/manager';
  if (
    /@glimmer\/(runtime|opcode-compiler|program|vm|encoder|wire-format|node)|shared-chunks\/(vm-ops|syscall-ops|opcodes|program|program-context|render|registers|rehydrate-builder|serialize-builder|curried|arguments|element|invoke|on|hash|get|curly|template|helper|internal-helper|not|normalize)-/.test(
      p
    )
  )
    return 'glimmer-vm';
  if (/@ember\/-internals\/glimmer/.test(p)) return 'ember-glimmer';
  if (
    /@ember\/-internals\/(utils|meta|owner|container|runtime|environment)|@ember\/object|shared-chunks\/(guid|intern|dictionary|lookup-descriptor|super|spec|name|is_proxy|get-debug-name|container|env|libraries|namespace_search|injected_property|set_properties|get_properties|computed_cache)-/.test(
      p
    )
  )
    return 'ember-object/utils';
  if (
    /@glimmer\/(util|debug-util|global-context|env)|shared-chunks\/(collections|array-utils|object-utils|debug-brand|assert|platform-utils|simple-cast|well-known|index)/.test(
      p
    )
  )
    return 'glimmer-util';
  if (/router_js|route-recognizer|@ember\/routing|@ember\/-internals\/routing/.test(p))
    return 'routing';
  if (/@glimmer\/component|glimmer-component/.test(p)) return 'glimmer-component';
  return `ember:${p.split('/').slice(-2).join('/')}`;
}

function selfTimes(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const dt = i + 1 < timeDeltas.length ? timeDeltas[i + 1] : 0;
    self.set(samples[i], (self.get(samples[i]) ?? 0) + dt);
  }
  return { byId, self };
}

function srcSnippet(source, line, col) {
  try {
    const text = readFileSync(source, 'utf8').split('\n')[line] ?? '';
    return text.slice(Math.max(0, col - 20), col + 70).trim();
  } catch (e) {
    return `(unreadable: ${e.code ?? e.message})`;
  }
}

async function profileCmd() {
  const variant = opt('--variant', 'gxt-native');
  const rows = opt('--rows', 'inline');
  const ops = opt('--ops', Object.keys(modeOf(rows).ops).join(',')).split(',');
  const iters = Number(opt('--iters', '5'));
  const outDir = opt('--out', null);
  if (!outDir) throw new Error('--out <dir> is required');
  mkdirSync(outDir, { recursive: true });
  const interval = Number(opt('--interval', '50'));
  const profiles = [];
  const { server, origin } = await startServer();
  const browser = await launch();
  let result;
  try {
    const collect = (op, iter, cpu, times) => profiles.push({ op, iter, cpu, times });
    result = await runPage(browser, origin, variant, rows, { ops, iters, interval, collect });
  } finally {
    await browser.close();
    server.close();
  }
  if (result.fatal) throw new Error(`profile page failed: ${result.fatal}`);
  const invalid = Object.entries(result.ops).filter(([, o]) => !o.ok);
  if (invalid.length) log(`WARNING invalid profiled ops: ${JSON.stringify(invalid)}`);
  const tag = `${variant}${rows === 'component' ? '-rowcomp' : ''}`;
  for (const { op, iter, cpu, times } of profiles) {
    cpu.krausestScriptMs = times.script;
    writeFileSync(join(outDir, `${tag}-${op}-${iter}.cpuprofile`), JSON.stringify(cpu));
  }
  attribute(variant, tag, profiles, outDir);
}

// Re-attribute saved profiles: `attribute --variant v [--rows component] --out dir`
function attributeCmd() {
  const variant = opt('--variant', 'gxt-native');
  const rows = opt('--rows', 'inline');
  const outDir = opt('--out', null);
  if (!outDir) throw new Error('--out <dir> is required');
  const tag = `${variant}${rows === 'component' ? '-rowcomp' : ''}`;
  const profiles = [];
  for (const f of readdirSync(outDir)) {
    const m = new RegExp(`^${tag}-([a-z0-9]+)-(\\d+)\\.cpuprofile$`).exec(f);
    if (!m) continue;
    const cpu = JSON.parse(readFileSync(join(outDir, f), 'utf8'));
    profiles.push({ op: m[1], iter: Number(m[2]), cpu, times: { script: cpu.krausestScriptMs } });
  }
  attribute(variant, tag, profiles, outDir);
}

function attribute(variant, tag, profiles, outDir) {
  const assets = join(DIST_ROOT, variant, 'assets');
  const mapFile = readdirSync(assets).find((f) => f.endsWith('.js.map'));
  const bundleName = mapFile.replace(/\.map$/, '');
  const lookup = makeLookup(JSON.parse(readFileSync(join(assets, mapFile), 'utf8')), assets);
  const callers = opt('--callers', null);
  if (callers) callerReport(profiles, callers.split(','), bundleName, lookup);
  const perOp = {};
  for (const { op, cpu, times } of profiles) {
    const { byId, self } = selfTimes(cpu);
    const agg = (perOp[op] ||= { totalUs: 0, wallMs: [], buckets: {}, fns: {} });
    agg.wallMs.push(times.script);
    for (const [id, us] of self) {
      const node = byId.get(id);
      const cf = node.callFrame;
      let bucket;
      let fnKey;
      if (cf.url.endsWith(bundleName)) {
        const pos = lookup(cf.lineNumber, cf.columnNumber);
        bucket = bucketOf(pos?.source);
        const where = pos
          ? `${relative(EMBER_ROOT, pos.source)}:${pos.line + 1}`
          : `bundle:${cf.lineNumber}:${cf.columnNumber}`;
        const name = pos?.name ?? cf.functionName;
        const snippet = pos ? srcSnippet(pos.source, pos.line, pos.col) : '';
        fnKey = `${bucket} | ${cf.functionName || '(anon)'}→${name ?? '?'} | ${where}${snippet ? ` | ${snippet}` : ''}`;
      } else {
        const special = { '(garbage collector)': 'gc', '(program)': 'program', '(idle)': 'idle' };
        bucket = cf.url
          ? 'other-url'
          : (special[cf.functionName] ??
            (/^kb\.|^canon$/.test(cf.functionName) ? 'harness' : 'dom/builtins'));
        fnKey = `${bucket} | ${cf.functionName} | ${cf.url}`;
      }
      if (bucket === 'idle') continue;
      // (program) = the browser's own work (style / layout / paint) between JS
      // tasks — outside the measured script window; reported, not in the shares.
      if (bucket === 'program') {
        agg.programUs = (agg.programUs ?? 0) + us;
        continue;
      }
      agg.totalUs += us;
      agg.buckets[bucket] = (agg.buckets[bucket] ?? 0) + us;
      agg.fns[fnKey] = (agg.fns[fnKey] ?? 0) + us;
    }
  }
  const report = {};
  for (const [op, agg] of Object.entries(perOp)) {
    const buckets = Object.entries(agg.buckets)
      .sort((a, b) => b[1] - a[1])
      .map(([k, us]) => ({
        bucket: k,
        ms: Number((us / 1000 / agg.wallMs.length).toFixed(3)),
        share: Number(((us / agg.totalUs) * 100).toFixed(1)),
      }));
    const fns = Object.entries(agg.fns)
      .sort((a, b) => b[1] - a[1])
      .map(([k, us]) => ({
        fn: k,
        ms: Number((us / 1000 / agg.wallMs.length).toFixed(3)),
        share: Number(((us / agg.totalUs) * 100).toFixed(1)),
      }));
    report[op] = {
      programMsPerIter: Number(((agg.programUs ?? 0) / 1000 / agg.wallMs.length).toFixed(2)),
      iters: agg.wallMs.length,
      wallMsMedian: median(agg.wallMs),
      sampledMsPerIter: Number((agg.totalUs / 1000 / agg.wallMs.length).toFixed(2)),
      buckets,
      fns,
    };
  }
  writeFileSync(join(outDir, `${tag}-attribution.json`), JSON.stringify(report, null, 1));
  for (const [op, r] of Object.entries(report)) {
    console.log(
      `\n## ${tag} ${op}: ${r.iters} iters, wall median ${fmt(r.wallMsMedian)} ms (profiled), sampled ${r.sampledMsPerIter} ms/iter`
    );
    console.log(
      `buckets: ${r.buckets.map((b) => `${b.bucket} ${b.share}% (${b.ms}ms)`).join(' · ')}`
    );
    for (const f of r.fns.slice(0, Number(opt('--top', '15'))))
      console.log(
        `  ${String(f.share).padStart(5)}% ${String(f.ms).padStart(7)}ms  ${f.fn.slice(0, 220)}`
      );
  }
}

// `attribute --callers fnA,fnB [--ops op1,op2]`: inclusive time of the named
// (source-mapped) functions per op, split by their 2-frame caller chain.
function callerReport(profiles, targets, bundleName, lookup) {
  const onlyOps = opt('--ops', null)?.split(',');
  const nameOf = (cf) => {
    if (!cf.url.endsWith(bundleName)) return cf.functionName || '(anon)';
    const pos = lookup(cf.lineNumber, cf.columnNumber);
    const file = pos ? basename(pos.source).replace(/-[\w]{8}\.js$/, '.js') : '?';
    return `${pos?.name ?? cf.functionName ?? '?'}@${file}:${pos ? pos.line + 1 : '?'}`;
  };
  const perOp = {};
  for (const { op, cpu } of profiles) {
    if (onlyOps && !onlyOps.includes(op)) continue;
    const agg = (perOp[op] ||= { iters: 0, targets: {} });
    agg.iters++;
    const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of cpu.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const label = new Map();
    const labelOf = (id) => {
      if (!label.has(id)) label.set(id, nameOf(byId.get(id).callFrame));
      return label.get(id);
    };
    const { samples, timeDeltas } = cpu;
    for (let i = 0; i < samples.length; i++) {
      const dt = i + 1 < timeDeltas.length ? timeDeltas[i + 1] : 0;
      for (const t of targets) {
        // innermost frame whose function name is t
        let id = samples[i];
        while (id !== undefined && !labelOf(id).startsWith(`${t}@`) && labelOf(id) !== t)
          id = parent.get(id);
        if (id === undefined) continue;
        // skip recursion: first ancestor with a different label
        let p = parent.get(id);
        while (p !== undefined && labelOf(p) === labelOf(id)) p = parent.get(p);
        const gp = p === undefined ? undefined : parent.get(p);
        const chain = `${p === undefined ? '(root)' : labelOf(p)} ← ${gp === undefined ? '(root)' : labelOf(gp)}`;
        const ta = (agg.targets[t] ||= { us: 0, chains: {} });
        ta.us += dt;
        ta.chains[chain] = (ta.chains[chain] ?? 0) + dt;
      }
    }
  }
  for (const [op, agg] of Object.entries(perOp)) {
    for (const [t, ta] of Object.entries(agg.targets)) {
      console.log(`\n[callers] ${op}: ${t} inclusive ${fmt(ta.us / 1000 / agg.iters)} ms/iter`);
      for (const [chain, us] of Object.entries(ta.chains)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)) {
        console.log(`  ${fmt(us / 1000 / agg.iters).padStart(8)} ms  ${chain}`);
      }
    }
  }
}

// ---------------------------------------------------------------- main
const COMMANDS = { build, bench, boot, profile: profileCmd, attribute: attributeCmd };
if (!COMMANDS[command]) {
  console.error(
    `usage: node scripts/krausest-bench.mjs <${Object.keys(COMMANDS).join('|')}> [options] (see header)`
  );
  process.exit(2);
}
try {
  await COMMANDS[command]();
} catch (e) {
  console.error(`[krausest] ${command} failed: ${e?.stack || e}`);
  process.exitCode = 1;
}
