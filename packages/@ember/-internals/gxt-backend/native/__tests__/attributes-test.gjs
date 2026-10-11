// gxt NATIVE layer: Ember/Glimmer attribute write semantics through gxt's
// `normalizeAttrValue` host hook (native/host-hooks.ts) — initial writes AND
// reactive re-applies.
import { trackedObject } from '@ember/reactive/collections';
import { htmlSafe } from '@ember/template';
import { run } from '@ember/runloop';
import { setupNativeRendering } from './-helpers';

const { module, test } = QUnit;

module('gxt-native | attributes', function (hooks) {
  setupNativeRendering(hooks);

  test('false / undefined / null remove the attribute; true writes it bare', function (assert) {
    const args = trackedObject({ v: 'x' });
    const Root = <template><div id="t" data-v={{@v}}></div></template>;
    this.render(Root, args);
    const el = () => this.element.querySelector('#t');
    assert.strictEqual(el().getAttribute('data-v'), 'x');
    run(() => (args.v = false));
    assert.false(el().hasAttribute('data-v'), 'false removes');
    run(() => (args.v = true));
    assert.strictEqual(el().getAttribute('data-v'), '', 'true writes an empty value');
    run(() => (args.v = null));
    assert.false(el().hasAttribute('data-v'), 'null removes');
    run(() => (args.v = 'back'));
    assert.strictEqual(el().getAttribute('data-v'), 'back');
    run(() => (args.v = undefined));
    assert.false(el().hasAttribute('data-v'), 'undefined removes');
  });

  test('values are stringified (numbers, symbols); no-toString objects remove', function (assert) {
    const args = trackedObject({ v: 1 });
    const Root = <template><div id="t" data-v={{@v}}></div></template>;
    this.render(Root, args);
    const el = () => this.element.querySelector('#t');
    assert.strictEqual(el().getAttribute('data-v'), '1');
    run(() => (args.v = Symbol('debug')));
    assert.strictEqual(el().getAttribute('data-v'), 'Symbol(debug)');
    run(() => (args.v = Object.create(null)));
    assert.false(el().hasAttribute('data-v'));
  });

  test('URL attributes are sanitized (javascript:/vbscript:); safe URLs pass', function (assert) {
    const args = trackedObject({ url: 'javascript:alert(1)' });
    const Root = <template><a id="a" href={{@url}}>x</a><img id="i" src={{@url}} /></template>;
    this.render(Root, args);
    assert.strictEqual(this.element.querySelector('#a').getAttribute('href'), 'unsafe:javascript:alert(1)');
    assert.strictEqual(this.element.querySelector('#i').getAttribute('src'), 'unsafe:javascript:alert(1)');
    run(() => (args.url = 'https://emberjs.com/'));
    assert.strictEqual(this.element.querySelector('#a').getAttribute('href'), 'https://emberjs.com/');
    run(() => (args.url = 'VBScript:x'));
    assert.strictEqual(this.element.querySelector('#a').getAttribute('href'), 'unsafe:VBScript:x');
    run(() => (args.url = '/relative/path'));
    assert.strictEqual(this.element.querySelector('#a').getAttribute('href'), '/relative/path');
  });

  test('SafeString attribute values write their HTML string', function (assert) {
    const Root = <template><div id="t" title={{@title}}></div></template>;
    this.render(Root, { title: htmlSafe('<b>t</b>') });
    assert.strictEqual(this.element.querySelector('#t').getAttribute('title'), '<b>t</b>');
  });
});
