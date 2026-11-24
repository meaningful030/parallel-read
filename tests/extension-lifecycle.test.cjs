const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');

function fakeDocument() {
  const nodes = [];
  const queries = [];
  return {
    nodes, queries,
    add({ owned = false, text = '' } = {}) {
      const element = {
        owned, textContent: text, removed: false,
        remove() { this.removed = true; }
      };
      nodes.push(element);
      return element;
    },
    querySelectorAll(selector) {
      queries.push(selector);
      assert.equal(selector, '[data-parallel-read-translation]');
      return nodes.filter(element => element.owned && !element.removed);
    }
  };
}

function freshContext(document, runtimeValid = true) {
  const listeners = [], messages = [];
  const runtime = {
    id: runtimeValid ? 'parallel-read-test-extension' : undefined,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    sendMessage(message) { messages.push(message); throw new Error('Initialization must not request translation.'); }
  };
  const context = vm.createContext({
    document,
    chrome: { runtime },
    location: { protocol: 'https:', pathname: '/article' }
  });
  return { context, listeners, messages, run() { vm.runInContext(source, context); } };
}

test('a fresh content context removes orphan translations and preserves original content', () => {
  const document = fakeDocument();
  const original = document.add({ text: 'The English original must remain intact.' });
  const orphanA = document.add({ owned: true, text: '舊譯文一' });
  const orphanB = document.add({ owned: true, text: '舊譯文二' });
  const h = freshContext(document);

  h.run();

  assert.equal(orphanA.removed, true);
  assert.equal(orphanB.removed, true);
  assert.equal(original.removed, false);
  assert.equal(original.textContent, 'The English original must remain intact.');
  assert.equal(h.listeners.length, 1);
  assert.equal(h.messages.length, 0);
  let state;
  h.listeners[0]({ type: 'PR_STATUS' }, { id: 'parallel-read-test-extension' }, result => { state = result; });
  assert.equal(state.active, false);
});

test('duplicate injection in the same context preserves current translations and registers no extra listener', () => {
  const document = fakeDocument();
  const h = freshContext(document);
  h.run();
  const currentTranslation = document.add({ owned: true, text: '這是目前閱讀中的譯文。' });
  const original = document.add({ text: 'This is the current English paragraph.' });
  const firstQueryCount = document.queries.length;

  h.run();

  assert.equal(currentTranslation.removed, false);
  assert.equal(original.removed, false);
  assert.equal(document.queries.length, firstQueryCount);
  assert.equal(h.listeners.length, 1);
  assert.equal(h.messages.length, 0);
});

test('a replacement extension context cleans translations left by an older context', () => {
  const document = fakeDocument();
  const oldContext = freshContext(document);
  oldContext.run();
  const oldTranslation = document.add({ owned: true, text: '重新載入之前的譯文。' });
  const original = document.add({ text: 'The source paragraph survives an extension update.' });
  const replacement = freshContext(document);

  replacement.run();

  assert.equal(oldTranslation.removed, true);
  assert.equal(original.removed, false);
  assert.equal(replacement.listeners.length, 1);
  assert.equal(replacement.messages.length, 0);
});

test('an invalid extension runtime performs no document mutation or registration', () => {
  const document = fakeDocument();
  const orphan = document.add({ owned: true, text: '由有效擴充功能管理的譯文。' });
  const h = freshContext(document, false);

  h.run();

  assert.equal(orphan.removed, false);
  assert.equal(document.queries.length, 0);
  assert.equal(h.listeners.length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.context.__parallelReadInstalled, undefined);
});

test('loading the script outside an extension is inert', () => {
  const document = fakeDocument();
  const original = document.add({ text: 'An ordinary web page stays unchanged.' });
  const orphan = document.add({ owned: true, text: '保留現有內容。' });
  const context = vm.createContext({ document, location: { protocol: 'https:', pathname: '/' } });

  vm.runInContext(source, context);

  assert.equal(original.removed, false);
  assert.equal(orphan.removed, false);
  assert.equal(document.queries.length, 0);
  assert.equal(context.__parallelReadInstalled, undefined);
});
