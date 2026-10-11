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

  test('...attributes precedence: attributes after it win, before it lose; classes in source order', function (assert) {
    const Before = <template><div class="own" data-x="own" title="own" ...attributes></div></template>;
    const After = <template><div ...attributes class="own" data-x="own" title={{@title}}></div></template>;
    const args = trackedObject({ title: 'local' });
    const Root = <template>
      <Before id="b" class="fw" data-x="fw" />
      <After id="a" class="fw" data-x="fw" title="fw" @title={{@title}} />
    </template>;
    this.render(Root, args);
    const before = this.element.querySelector('#b');
    const after = this.element.querySelector('#a');
    assert.strictEqual(before.getAttribute('data-x'), 'fw', 'forwarded wins over an attribute before it');
    assert.strictEqual(before.getAttribute('title'), 'own', 'a non-forwarded attribute stays');
    assert.strictEqual(before.className, 'own fw', 'own class first');
    assert.strictEqual(after.getAttribute('data-x'), 'own', 'an attribute after ...attributes wins');
    assert.strictEqual(after.getAttribute('title'), 'local');
    assert.strictEqual(after.className, 'fw own', 'forwarded class first');
    assert.false(after.hasOwnProperty('__splatLocal__'), 'the precedence marker is not applied');
    run(() => (args.title = 'changed'));
    assert.strictEqual(after.getAttribute('title'), 'changed', 'the winning local binding stays reactive');
  });

  test('SafeString attribute values write their HTML string', function (assert) {
    const Root = <template><div id="t" title={{@title}}></div></template>;
    this.render(Root, { title: htmlSafe('<b>t</b>') });
    assert.strictEqual(this.element.querySelector('#t').getAttribute('title'), '<b>t</b>');
  });
});
