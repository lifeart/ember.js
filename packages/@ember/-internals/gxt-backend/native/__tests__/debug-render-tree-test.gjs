// gxt NATIVE layer: `renderer:-dom`.debugRenderTree.capture() → gxt
// captureRenderTree over the owner's render roots, with component names from
// the native `resolveComponentName` host hook (not gxt's internal `NativeComponent`
// factory / template wrapper names).
import Component from '@glimmer/component';
import { setComponentTemplate } from '@ember/component';
import templateOnly from '@ember/component/template-only';
import { setupNativeRendering } from './-helpers';

const { module, test } = QUnit;

function names(nodes, out = []) {
  for (const node of nodes) {
    out.push(node.name);
    names(node.children, out);
  }
  return out;
}

module('gxt-native | debugRenderTree', function (hooks) {
  setupNativeRendering(hooks);

  test('capture() names Ember components by their definition', function (assert) {
    const InnerTemplateOnly = <template><i>{{@v}}</i></template>;
    const Badge = setComponentTemplate(<template><b>badge</b></template>, templateOnly('my-app/badge', 'Badge'));
    class OuterCard extends Component {
      <template><section><InnerTemplateOnly @v="1" /><Badge /></section></template>
    }
    this.render(OuterCard);

    const renderer = this.owner.lookup('renderer:-dom');
    const tree = renderer.debugRenderTree.capture();
    const all = names(tree);

    assert.strictEqual(tree.length, 1, 'one root for this owner');
    assert.strictEqual(tree[0].name, 'OuterCard', 'class component named by its class');
    assert.ok(all.includes('InnerTemplateOnly'), `template-only gxt component named by its binding (${all.join(', ')})`);
    assert.ok(all.includes('Badge'), 'templateOnly() definition named by its definition name');
    assert.notOk(all.includes('NativeComponent'), 'never the native factory name');
    assert.strictEqual(tree[0].type, 'component');
    assert.ok(tree[0].bounds && tree[0].bounds.firstNode, 'bounds captured');
  });

  test('capture() is scoped to the renderer owner and drops destroyed roots', function (assert) {
    const Leaf = <template>leaf</template>;
    this.render(Leaf);
    const renderer = this.owner.lookup('renderer:-dom');
    assert.strictEqual(renderer.debugRenderTree.capture().length, 1);
    this.result.destroy();
    this.result = null;
    assert.strictEqual(renderer.debugRenderTree.capture().length, 0);
  });
});
