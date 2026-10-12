/**
 * Regression tests for compat-layer fixes where gxt-backend diverged from
 * classic Ember. The test page loads this file only in GXT builds
 * (`virtual:gxt-tests`).
 */
import { CustomComponentManager, componentCapabilities } from '../manager';
import { destroy } from '../destroyable';

declare const QUnit: any;

QUnit.module('GXT correctness: CustomComponentManager', function () {
  function managerFor(delegate: object) {
    const manager = new CustomComponentManager(() => delegate);
    const state = manager.create({}, {}, { named: {}, positional: [] });
    return { manager, state };
  }

  QUnit.test(
    'didCreate / didUpdate call the delegate when it has asyncLifecycleCallbacks',
    function (assert: any) {
      const calls: string[] = [];
      const { manager, state } = managerFor({
        capabilities: componentCapabilities('3.13', {
          asyncLifecycleCallbacks: true,
          updateHook: true,
        }),
        createComponent: () => ({}),
        updateComponent() {},
        didCreateComponent: () => calls.push('didCreateComponent'),
        didUpdateComponent: () => calls.push('didUpdateComponent'),
      });

      manager.didCreate(state);
      manager.didUpdate(state);

      assert.deepEqual(calls, ['didCreateComponent', 'didUpdateComponent']);
    }
  );

  QUnit.test(
    'destroying the destroyable runs the delegate destroyComponent',
    function (assert: any) {
      const calls: string[] = [];
      const { manager, state } = managerFor({
        capabilities: componentCapabilities('3.13', { destructor: true }),
        createComponent: () => ({}),
        destroyComponent: () => calls.push('destroyComponent'),
      });

      const destroyable = manager.getDestroyable(state);
      assert.strictEqual(destroyable, state, 'the bucket is the destroyable');
      destroy(destroyable);

      assert.deepEqual(calls, ['destroyComponent']);
    }
  );
});
