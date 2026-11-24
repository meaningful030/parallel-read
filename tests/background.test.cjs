"use strict";
// Background service worker logic in a vm sandbox with a fake chrome API and
// MOCKED network. Checks settings, key isolation and cancellation, not quality.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const directory = path.join(__dirname, "../extension");
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const KEY = "dummy-local-test-key-never-real";
const OTHER_KEY = "dummy-replacement-test-key-never-real";
const EXTENSION = "parallel-read-test-extension";
const optionsSender = { id: EXTENSION, url: `chrome-extension://${EXTENSION}/options.html` };
const contentSender = { id: EXTENSION, url: "https://example.com/article", tab: { id: 1 } };
const popupSender = { id: EXTENSION, url: `chrome-extension://${EXTENSION}/popup.html` };
const GOOGLE = "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-TW&format=text";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

function harness(initial, { hold = false } = {}) {
  const data = initial ? { parallelReadAI: clone(initial) } : {};
  const changed = [], listeners = [], requests = [], writes = [], access = [];
  const granted = new Set(["https://translate.googleapis.com/*", "https://generativelanguage.googleapis.com/*"]);
  let revision = 0, beforeSet = null;
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout, JSON, Date,
    crypto: { randomUUID: () => `revision-${++revision}` },
    fetch: (url, init) => {
      requests.push({ url, init });
      const respond = () => {
        if (url.startsWith("https://translate.googleapis.com/")) {
          return { ok: true, status: 200, json: async () => new URLSearchParams(init.body).getAll("q").map(() => "這是模擬譯文。") };
        }
        const payload = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
        return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ translations: payload.segments.map(s => ({ id: s.id, text: "這是 Gemini 模擬譯文。" })) }) }] } }] }) };
      };
      if (!hold) return Promise.resolve(respond());
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
      });
    },
    chrome: {
      runtime: {
        id: EXTENSION,
        getURL: file => `chrome-extension://${EXTENSION}/${file}`,
        onMessage: { addListener: listener => listeners.push(listener) }
      },
      permissions: { contains: async ({ origins }) => origins.every(origin => granted.has(origin)) },
      storage: {
        local: {
          setAccessLevel: async value => { access.push(value); },
          get: async key => ({ [key]: clone(data[key]) }),
          set: async values => {
            writes.push(clone(values));
            if (beforeSet) await beforeSet(values);
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
              data[key] = clone(value);
            }
            for (const listener of changed) listener(changes, "local");
          }
        },
        onChanged: { addListener: listener => changed.push(listener) }
      }
    }
  });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(directory, name), "utf8"), context));
  vm.runInContext(fs.readFileSync(path.join(directory, "background.js"), "utf8"), context);
  return {
    data, requests, writes, access,
    revoke(origin) { granted.delete(origin); },
    setHook(callback) { beforeSet = callback; },
    send(message, sender = optionsSender) {
      return new Promise(resolve => listeners[0](message, sender, result => resolve(clone(result))));
    }
  };
}

const geminiSettings = (extra = {}) => ({ engine: "gemini", gemini: { apiKey: KEY, model: "gemini-3.8-flash", freeTierConfirmed: true, ...extra }, revision: "rev-1" });
const translate = (revision, extra = {}) => ({ type: "PR_TRANSLATE", revision, segments: [{ text: "The same English sentence.", literals: [] }], context: {}, ...extra });
const hasKey = value => JSON.stringify(value).includes(KEY);

test("fresh install works immediately with keyless Google Translate", async () => {
  const h = harness();
  const config = await h.send({ type: "PR_GET_PUBLIC_CONFIG" }, contentSender);
  assert.equal(config.ok, true);
  assert.equal(config.ready, true);
  assert.equal(config.engine, "google");
  const result = await h.send(translate(config.revision), contentSender);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{ ok: true, text: "這是模擬譯文。" }]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, GOOGLE);
  assert.deepEqual(clone(h.access), [{ accessLevel: "TRUSTED_CONTEXTS" }]);
});

test("0.2.0 settings are migrated: an existing confirmed key keeps using Gemini", async () => {
  const h = harness({ endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.8-flash", apiKey: KEY, freeTierConfirmed: true, revision: "old-rev" });
  const settings = await h.send({ type: "PR_GET_SETTINGS" });
  assert.equal(settings.settings.engine, "gemini");
  assert.equal(settings.settings.gemini.hasKey, true);
  assert.equal(hasKey(settings), false);
  const result = await h.send(translate("old-rev"), contentSender);
  assert.equal(result.ok, true);
  assert.equal(h.requests[0].url, GEMINI);
  const unconfirmed = harness({ endpoint: "x", model: "gemini-3.8-flash", apiKey: KEY, freeTierConfirmed: false });
  assert.equal((await unconfirmed.send({ type: "PR_GET_PUBLIC_CONFIG" }, contentSender)).engine, "google");
});

test("web pages cannot read, save, clear or test settings", async () => {
  const h = harness(geminiSettings());
  for (const type of ["PR_GET_SETTINGS", "PR_SAVE_SETTINGS", "PR_CLEAR_KEY", "PR_TEST_CONNECTION"]) {
    const result = await h.send({ type, settings: geminiSettings() }, contentSender);
    assert.equal(result.code, "FORBIDDEN");
    assert.equal(hasKey(result), false);
  }
  assert.equal((await h.send(translate("rev-1"), { id: "another-extension", tab: { id: 2 } })).code, "FORBIDDEN");
  assert.equal(h.writes.length, 0);
  assert.equal(h.requests.length, 0);
});

test("settings and public configuration never return the key", async () => {
  const h = harness(geminiSettings());
  for (const [message, sender] of [[{ type: "PR_GET_SETTINGS" }, optionsSender], [{ type: "PR_GET_PUBLIC_CONFIG" }, contentSender], [{ type: "PR_GET_PUBLIC_CONFIG" }, popupSender]]) {
    const result = await h.send(message, sender);
    assert.equal(result.ok, true);
    assert.equal(hasKey(result), false);
  }
});

test("Gemini without key or confirmation never issues a request", async () => {
  for (const initial of [geminiSettings({ apiKey: "" }), geminiSettings({ freeTierConfirmed: false })]) {
    const h = harness(initial);
    const config = await h.send({ type: "PR_GET_PUBLIC_CONFIG" }, contentSender);
    assert.equal(config.ready, false);
    assert.ok(config.reason);
    assert.equal((await h.send(translate("rev-1"), contentSender)).code, "SETTINGS_REQUIRED");
    assert.equal((await h.send({ type: "PR_TEST_CONNECTION" })).code, "SETTINGS_REQUIRED");
    assert.equal(h.requests.length, 0);
  }
});

test("saving validates confirmation, permission and the free model allowlist, and never calls a service", async () => {
  const h = harness();
  const save = settings => h.send({ type: "PR_SAVE_SETTINGS", settings });
  assert.equal((await save({ engine: "gemini", gemini: { apiKey: KEY } })).code, "INVALID_SETTINGS");
  assert.equal((await save({ engine: "gemini", gemini: { apiKey: KEY, model: "gemini-4-argon", freeTierConfirmed: true } })).code, "INVALID_SETTINGS");
  assert.equal((await save({ engine: "paid-service" })).code, "INVALID_SETTINGS");
  h.revoke("https://generativelanguage.googleapis.com/*");
  assert.equal((await save({ engine: "gemini", gemini: { apiKey: KEY, freeTierConfirmed: true } })).code, "PERMISSION_REQUIRED");
  assert.equal(h.writes.length, 0);
  const saved = await save({ engine: "google" });
  assert.equal(saved.ok, true);
  assert.equal(saved.publicConfig.engine, "google");
  assert.equal(h.requests.length, 0);
});

test("a blank key field keeps the saved key", async () => {
  const h = harness(geminiSettings());
  const saved = await h.send({ type: "PR_SAVE_SETTINGS", settings: { engine: "gemini", gemini: { apiKey: "", model: "gemini-3.5-flash-lite", freeTierConfirmed: true } } });
  assert.equal(saved.ok, true);
  assert.equal(h.data.parallelReadAI.gemini.apiKey, KEY);
  assert.equal(h.data.parallelReadAI.gemini.model, "gemini-3.5-flash-lite");
  assert.equal(hasKey(saved), false);
  assert.equal(h.requests.length, 0);
});

test("save and clear are serialized so a later clear cannot resurrect the key", async () => {
  const h = harness(geminiSettings());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  h.setHook(async () => { if (++calls === 1) await gate; });
  const save = h.send({ type: "PR_SAVE_SETTINGS", settings: { engine: "gemini", gemini: { apiKey: OTHER_KEY, freeTierConfirmed: true } } });
  const clear = h.send({ type: "PR_CLEAR_KEY" });
  await flush();
  assert.equal(h.writes.length, 1);
  release();
  assert.equal((await save).ok, true);
  assert.equal((await clear).ok, true);
  assert.equal(h.data.parallelReadAI.gemini.apiKey, "");
  assert.equal(h.data.parallelReadAI.gemini.freeTierConfirmed, false);
  const config = await h.send({ type: "PR_GET_PUBLIC_CONFIG" }, contentSender);
  assert.equal((await h.send(translate(config.revision), contentSender)).code, "SETTINGS_REQUIRED");
  assert.equal(h.requests.length, 0);
});

test("requests from a page started under older settings are refused before any network call", async () => {
  const h = harness(geminiSettings());
  assert.equal((await h.send(translate("rev-1"), contentSender)).ok, true);
  await h.send({ type: "PR_SAVE_SETTINGS", settings: { engine: "google" } });
  const stale = await h.send(translate("rev-1"), contentSender);
  assert.equal(stale.code, "SETTINGS_CHANGED");
  assert.equal(h.requests.length, 1);
  const config = await h.send({ type: "PR_GET_PUBLIC_CONFIG" }, contentSender);
  assert.equal((await h.send(translate(config.revision), contentSender)).ok, true);
  assert.equal(h.requests[1].url, GOOGLE, "the new service is used only after restarting with the new revision");
});

test("clearing the key aborts in-flight Gemini work and queued requests never reach the network", async () => {
  const h = harness(geminiSettings(), { hold: true });
  const first = h.send(translate("rev-1", { segments: [{ text: "First queued paragraph.", literals: [] }] }), contentSender);
  const second = h.send(translate("rev-1", { segments: [{ text: "Second queued paragraph.", literals: [] }] }), contentSender);
  for (let i = 0; i < 20 && h.requests.length < 1; i += 1) await flush();
  assert.equal(h.requests.length, 1, "Gemini sends one request at a time");
  assert.equal((await h.send({ type: "PR_CLEAR_KEY" })).ok, true);
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok === false && ["ABORTED", "SETTINGS_CHANGED"].includes(result.code)), JSON.stringify(results));
  assert.equal(h.requests.length, 1);
});

test("the Gemini key is sent only in its header to the fixed endpoint", async () => {
  const h = harness(geminiSettings());
  const result = await h.send(translate("rev-1", { context: { title: "Article", section: "Intro", next: "After", previous: { source: "Before", translation: "之前" } } }), contentSender);
  assert.equal(result.ok, true);
  const request = h.requests[0];
  assert.equal(request.url, GEMINI);
  assert.equal(request.init.headers["x-goog-api-key"], KEY);
  assert.equal(request.init.body.includes(KEY), false);
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "error");
  assert.equal(hasKey(result), false);
});

test("malformed translation messages are rejected without a request", async () => {
  const h = harness();
  const config = await h.send({ type: "PR_GET_PUBLIC_CONFIG" }, contentSender);
  for (const segments of [[], undefined, Array.from({ length: 13 }, () => ({ text: "Too many.", literals: [] }))]) {
    assert.equal((await h.send(translate(config.revision, { segments }), contentSender)).code, "INVALID_TEXT");
  }
  assert.equal(h.requests.length, 0);
});

test("test connection uses the saved service and reports the sentence it sent", async () => {
  const h = harness();
  const result = await h.send({ type: "PR_TEST_CONNECTION" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "這是模擬譯文。");
  assert.match(result.source, /not be deleted/);
  assert.equal(h.requests[0].url, GOOGLE);
});
