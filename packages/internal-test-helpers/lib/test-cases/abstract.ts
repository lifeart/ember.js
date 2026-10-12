/* global Element */

import NodeQuery from '../node-query';
import equalInnerHTML from '../equal-inner-html';
import equalTokens from '../equal-tokens';
import { assertInvariants, getElement, takeSnapshot } from '../element-helpers';
import { equalsElement, regex, classes } from '../matchers';
import { runDestroy, runLoopSettled, runTask } from '../run';
import { assert } from '@ember/debug';
import { rerenderComponent } from '../component-helper';
import { _resetRenderers } from '@ember/-internals/glimmer';
import {
  getGxtRenderer,
  getAmbientOwner,
  setAmbientOwner,
} from '@ember/-internals/gxt-backend/gxt-bridge';

const TextNode = window.Text;
const HTMLElement = window.HTMLElement;
const Comment = window.Comment;

function isMarker(node: unknown): node is Comment | typeof TextNode {
  if (node instanceof Comment) {
    const text = node.textContent || '';
    // Empty comments are Glimmer VM markers
    if (text === '') return true;
    // GXT internal placeholder comments
    if (
      __GXT_MODE__ &&
      (text.includes('placeholder') ||
        text.includes('curried-start') ||
        text.includes('curried-end') ||
        text === '/htmlRaw')
    ) {
      return true;
    }
  }

  if (node instanceof TextNode && node.textContent === '') {
    return true;
  }

  return false;
}

// GXT test-harness steps, `undefined` in classic builds. A module-level value
// instead of bridge calls inside the test-case methods: rollup keeps every
// binding a test-case method refers to (the classes escape into `moduleFor`),
// even from a folded `__GXT_MODE__` branch, which would keep gxt-backend in the
// classic test build.
const gxtHarness = __GXT_MODE__
  ? {
      cleanupActiveComponents() {
        // Clean up GXT active components before destroy.
        getGxtRenderer()?.compilePipeline.cleanupActiveComponents?.();
      },
      flushModifierDestroys() {
        // Flush pending GXT modifier destroys so willDestroyElement fires during
        // teardown, matching the Glimmer VM, which calls destroyModifier
        // synchronously when the element is removed.
        try {
          const pendingDestroys = getGxtRenderer()?.compilePipeline.getPendingModifierDestroys?.();
          if (pendingDestroys && pendingDestroys.length > 0) {
            const toFlush = pendingDestroys.splice(0) as any[];
            for (const entry of toFlush) {
              if (!entry.cached.pendingDestroy) continue;
              try {
                if (
                  entry.isCustom &&
                  entry.cached.manager?.destroyModifier &&
                  !entry.cached.instance?.__gxtModDestroyed
                ) {
                  entry.cached.manager.destroyModifier(entry.cached.instance);
                  if (entry.cached.instance) entry.cached.instance.__gxtModDestroyed = true;
                }
                // Modifier destroyables are already cleaned up by gxt-backend's
                // own teardown path.
              } catch {
                /* ignore individual modifier destroy errors */
              }
              const elCache = entry.cache?.get(entry.element);
              if (elCache) {
                elCache.delete(entry.modKey);
                if (elCache.size === 0) entry.cache.delete(entry.element);
              }
            }
          }
          // Also destroy any custom modifiers that are still active (their
          // formula destructors might not have fired during cleanup).
          const modMgr = getGxtRenderer()?.compilePipeline.getManagers?.()?.modifier;
          if (modMgr?._updatedInstances) {
            // Walk recently-active instances and call destroyModifier on their managers
            for (const inst of modMgr._updatedInstances) {
              try {
                if (inst?.__gxtModManager?.destroyModifier && !inst.__gxtModDestroyed) {
                  inst.__gxtModManager.destroyModifier(inst);
                  inst.__gxtModDestroyed = true;
                }
              } catch {
                /* ignore */
              }
            }
            modMgr._updatedInstances.clear();
          }
        } catch {
          /* ignore */
        }

        // Clear a stale ambient owner so subsequent tests don't see a destroyed owner
        if (getAmbientOwner()?.isDestroyed || getAmbientOwner()?.isDestroying) {
          setAmbientOwner(null);
        }
      },
      resetSyncState() {
        // Clear the GXT pending-sync flags.
        const _cpAT = getGxtRenderer()?.compilePipeline;
        _cpAT?.setPendingSync?.(false);
        _cpAT?.setPendingSyncFromPropertyChange?.(false);
        // Clear stale render errors so they don't leak into the next test.
        // Errors such as backtracking assertions are caught by
        // assert.rejectsAssertion but also queued by gxt-backend, and the
        // queued copy would otherwise rethrow later.
        _cpAT?.clearRenderErrors?.();
      },
    }
  : undefined;

export type TestCase = AbstractStrictTestCase | AbstractTestCase;

export abstract class AbstractStrictTestCase {
  snapshot: ChildNode[] | null = null;
  component: unknown;
  readonly assert: QUnit['assert'];

  rerender(): void {
    rerenderComponent();
  }

  beforeEach?(_assert: QUnit['assert']) {}
  teardown?(): unknown;

  constructor(assert: QUnit['assert']) {
    this.assert = assert;
  }

  afterEach() {
    try {
      if (__GXT_MODE__) {
        gxtHarness!.cleanupActiveComponents();
      }

      runDestroy(this);

      if (__GXT_MODE__) {
        gxtHarness!.flushModifierDestroys();
      }
    } finally {
      _resetRenderers();
      if (__GXT_MODE__) {
        gxtHarness!.resetSyncState();
      }
    }
  }

  takeSnapshot() {
    this.snapshot = takeSnapshot();
  }

  assertStableRerender() {
    this.takeSnapshot();
    runTask(() => rerenderComponent());
    this.assertInvariants();
  }

  assertInvariants(): void;
  assertInvariants(oldSnapshot: ChildNode[], newSnapshot: ChildNode[]): void;
  assertInvariants(oldSnapshot?: ChildNode[], newSnapshot?: ChildNode[]): void {
    if (!oldSnapshot) {
      assert('expected an existing snapshot', this.snapshot);
      oldSnapshot = this.snapshot;
    }
    assertInvariants(oldSnapshot, newSnapshot);
  }
}

export default abstract class AbstractTestCase {
  snapshot: ChildNode[] | null;
  assert: QUnit['assert'];

  get fixture(): string | undefined {
    return undefined;
  }

  constructor(assert: QUnit['assert']) {
    this.snapshot = null;
    this.assert = assert;

    let { fixture } = this;
    if (fixture) {
      this.setupFixture(fixture);
    }
  }

  teardown() {}
  beforeEach(_assert: QUnit['assert']) {}
  afterEach() {}

  setupFixture(innerHTML: string) {
    let fixture = document.getElementById('qunit-fixture')!;
    fixture.innerHTML = innerHTML;
  }

  // The following methods require `this.element` to work

  get firstChild() {
    return this.nthChild(0);
  }

  nthChild(n: number) {
    let i = 0;
    let node = getElement().firstChild;

    while (node) {
      if (!isMarker(node)) {
        i++;
      }

      if (i > n) {
        break;
      } else {
        node = node.nextSibling;
      }
    }

    return node;
  }

  get nodesCount() {
    let count = 0;
    let node = getElement().firstChild;

    while (node) {
      if (!isMarker(node)) {
        count++;
      }

      node = node.nextSibling;
    }

    return count;
  }

  $(sel?: string | HTMLElement) {
    if (sel instanceof HTMLElement) {
      return NodeQuery.element(sel);
    } else if (typeof sel === 'string') {
      return NodeQuery.query(sel, getElement());
    } else if (sel !== undefined) {
      throw new Error(`Invalid this.$(${sel})`);
    } else {
      return NodeQuery.element(getElement());
    }
  }

  wrap(element: HTMLElement) {
    return NodeQuery.element(element);
  }

  click(selector: HTMLElement | string) {
    let element;
    if (typeof selector === 'string') {
      element = getElement().querySelector(selector) as HTMLElement | null;
    } else {
      element = selector;
    }

    let event = element!.click();

    return runLoopSettled(event);
  }

  textValue() {
    return getElement().textContent;
  }

  takeSnapshot() {
    let snapshot: ChildNode[] = (this.snapshot = []);

    let node = getElement().firstChild;

    while (node) {
      if (!isMarker(node)) {
        snapshot.push(node);
      }

      node = node.nextSibling;
    }

    return snapshot;
  }

  assertText(text: string) {
    this.assert.strictEqual(
      this.textValue(),
      text,
      `#qunit-fixture content should be: \`${text}\``
    );
  }

  assertInnerHTML(html: string) {
    equalInnerHTML(this.assert, getElement(), html);
  }

  assertHTML(html: string) {
    equalTokens(getElement(), html, `#qunit-fixture content should be: \`${html}\``);
  }

  assertElement(
    node: Element,
    {
      ElementType = HTMLElement,
      tagName,
      attrs = null,
      content = null,
    }: {
      ElementType?: typeof HTMLElement;
      tagName: string;
      attrs?: Record<string, unknown> | null;
      content?: unknown;
    }
  ) {
    if (!(node instanceof ElementType)) {
      throw new Error(`Expecting a ${ElementType.name}, but got ${String(node)}`);
    }

    equalsElement(this.assert, node, tagName, attrs, content);
  }

  assertComponentElement(
    node: ChildNode | null,
    {
      ElementType = HTMLElement,
      tagName = 'div',
      attrs = {},
      content = null,
    }: {
      ElementType?: typeof HTMLElement;
      tagName: string;
      attrs?: Record<string, unknown>;
      content?: unknown;
    }
  ) {
    if (node === null || !(node?.nodeType === 1 && node instanceof Element)) {
      this.assert.ok(false, `Expected a ${ElementType.name}, but got ${String(node)}`);
      return;
    }

    attrs = Object.assign(
      {},
      { id: regex(/^ember\d*$/), class: classes('ember-view') },
      attrs || {}
    );
    this.assertElement(node, { ElementType, tagName, attrs, content });
  }

  assertSameNode(actual: ChildNode | undefined, expected: ChildNode | undefined) {
    this.assert.strictEqual(actual, expected, 'DOM node stability');
  }

  assertInvariants(): void;
  assertInvariants(oldSnapshot: ChildNode[], newSnapshot: ChildNode[]): void;
  assertInvariants(oldSnapshot?: ChildNode[], newSnapshot?: ChildNode[]): void {
    if (!oldSnapshot) {
      assert('expected an existing snapshot', this.snapshot);
      oldSnapshot = this.snapshot;
    }
    newSnapshot = newSnapshot || this.takeSnapshot();

    this.assert.strictEqual(newSnapshot.length, oldSnapshot.length, 'Same number of nodes');

    for (let i = 0; i < oldSnapshot.length; i++) {
      this.assertSameNode(newSnapshot[i], oldSnapshot[i]);
    }
  }

  assertPartialInvariants(start: number, end: number) {
    assert('expected an existing snapshot', this.snapshot);
    this.assertInvariants(this.snapshot, this.takeSnapshot().slice(start, end));
  }
}
