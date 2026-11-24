/* global chrome, importScripts, ParallelReadEngine, ParallelReadConfig */
"use strict";
importScripts("config.js", "engine.js");

// Same storage key as 0.2.0 so an existing key/confirmation is migrated, not lost.
const STORAGE_KEY = "parallelReadAI";
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const KNOWN_ERRORS = new Set([
  "ABORTED", "SETTINGS_CHANGED", "INVALID_SETTINGS", "SETTINGS_REQUIRED", "PERMISSION_REQUIRED", "AUTH_INVALID",
  "PERMISSION_DENIED", "MODEL_NOT_FOUND", "RATE_LIMITED", "QUOTA_EXHAUSTED", "FREE_TIER_UNAVAILABLE", "REQUEST_REJECTED",
  "SERVICE_ERROR", "SERVICE_BUSY", "TIMEOUT", "NETWORK", "INVALID_RESPONSE", "INCOMPLETE_RESPONSE", "CONTENT_FILTERED",
  "INVALID_TEXT", "TEXT_TOO_LONG"
]);
const TEST_SENTENCE = "If the update fails, your saved files will not be deleted.";
let currentEngine = null;
let engineIdentity = "";
let configurationVersion = 0;
let mutationQueue = Promise.resolve();

function problem(code, message) { return Object.assign(new Error(message), { code }); }

// Disposing aborts in-flight requests and rejects queued work of the old engine.
function resetEngine() {
  configurationVersion += 1;
  currentEngine?.dispose();
  currentEngine = null;
  engineIdentity = "";
}

function trustedSettingsPage(sender) {
  try {
    const url = new URL(sender.url);
    const expected = new URL(chrome.runtime.getURL("options.html"));
    return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname;
  } catch { return false; }
}

async function stored() {
  await storageReady;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return ParallelReadConfig.migrate(result[STORAGE_KEY]);
}

function lenient(value) {
  try { return ParallelReadConfig.normalize(value, { requireReady: false }); }
  catch { return ParallelReadConfig.normalize({}, { requireReady: false }); }
}

async function publicConfig() {
  const value = await stored();
  let settings;
  let reason = "";
  try { settings = ParallelReadConfig.normalize(value); }
  catch (error) { settings = lenient(value); reason = error.message; }
  let ready = !reason;
  if (ready && !await chrome.permissions.contains({ origins: [ParallelReadConfig.originPattern(settings.engine)] })) {
    ready = false;
    reason = "尚未允許連線到翻譯服務，請到設定頁重新保存並允許連線。";
  }
  return { ready, reason, revision: value.revision || "", ...ParallelReadConfig.describe(settings) };
}

async function engine(expectedRevision) {
  await mutationQueue;
  const version = configurationVersion;
  const value = await stored();
  if (typeof expectedRevision === "string" && expectedRevision !== (value.revision || "")) {
    throw problem("SETTINGS_CHANGED", "翻譯設定已變更。請按「重新嘗試」，以新設定重新翻譯這個網頁。");
  }
  let settings;
  try { settings = ParallelReadConfig.normalize(value); }
  catch (error) { throw problem("SETTINGS_REQUIRED", error.message); }
  if (!await chrome.permissions.contains({ origins: [ParallelReadConfig.originPattern(settings.engine)] })) {
    throw problem("PERMISSION_REQUIRED", "尚未允許連線到翻譯服務，請到設定頁重新保存並允許連線。");
  }
  if (version !== configurationVersion) throw problem("SETTINGS_CHANGED", "翻譯設定已變更，請重新開始翻譯。");
  const gemini = settings.engine === "gemini";
  const identity = JSON.stringify([settings.engine, gemini ? settings.gemini.model : "", gemini ? settings.gemini.apiKey : "", value.revision || ""]);
  if (!currentEngine || identity !== engineIdentity) {
    currentEngine?.dispose();
    currentEngine = gemini
      ? ParallelReadEngine.createGeminiEngine(fetch, { config: { apiKey: settings.gemini.apiKey, model: settings.gemini.model, thinkingLevel: ParallelReadConfig.GEMINI_MODELS[settings.gemini.model].thinkingLevel } })
      : ParallelReadEngine.createGoogleEngine(fetch);
    engineIdentity = identity;
  }
  return currentEngine;
}

function serializeMutation(operation) {
  const promise = mutationQueue.then(operation);
  mutationQueue = promise.catch(() => {});
  return promise;
}

async function saveSettings(input) {
  const previous = await stored();
  const candidate = ParallelReadConfig.normalize(input || {}, { requireReady: false });
  // A blank key field keeps the saved key; the key is never sent back to the page.
  if (!candidate.gemini.apiKey) candidate.gemini.apiKey = previous.gemini?.apiKey || "";
  const validated = ParallelReadConfig.normalize(candidate);
  if (!await chrome.permissions.contains({ origins: [ParallelReadConfig.originPattern(validated.engine)] })) {
    throw problem("PERMISSION_REQUIRED", "請先允許擴充功能連線到所選的翻譯服務，再保存設定。");
  }
  resetEngine();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...validated, revision: crypto.randomUUID() } });
  return { ok: true, publicConfig: await publicConfig() };
}

function cleanString(value, maximum) { return typeof value === "string" ? value.slice(0, maximum) : ""; }

function translationRequest(message) {
  if (!Array.isArray(message.segments) || !message.segments.length || message.segments.length > ParallelReadEngine.MAX_SEGMENTS) {
    throw problem("INVALID_TEXT", "沒有可翻譯的文字。");
  }
  const segments = message.segments.map(segment => ({
    text: cleanString(segment?.text, ParallelReadEngine.MAX_SEGMENT_LENGTH + 1),
    literals: Array.isArray(segment?.literals) ? segment.literals.slice(0, 41).map(item => cleanString(item, 401)) : []
  }));
  const context = message.context || {};
  const previous = context.previous && typeof context.previous === "object"
    ? { source: cleanString(context.previous.source, 2000), translation: cleanString(context.previous.translation, 2000) }
    : undefined;
  return {
    segments,
    context: { title: cleanString(context.title, 400), section: cleanString(context.section, 400), next: cleanString(context.next, 1000), previous }
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) resetEngine();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const types = ["PR_TRANSLATE", "PR_GET_PUBLIC_CONFIG", "PR_GET_SETTINGS", "PR_SAVE_SETTINGS", "PR_CLEAR_KEY", "PR_TEST_CONNECTION"];
  if (!types.includes(message?.type)) return false;
  if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false, code: "FORBIDDEN", error: "無法識別請求來源。" }); return false; }
  const optionsPage = trustedSettingsPage(sender);
  const ownPage = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  // Web pages (content scripts) may only translate and read public, key-free status.
  const allowed = ["PR_TRANSLATE", "PR_GET_PUBLIC_CONFIG"].includes(message.type) ? Boolean(sender.tab || ownPage) : optionsPage;
  if (!allowed) { sendResponse({ ok: false, code: "FORBIDDEN", error: "請從擴充功能設定頁操作。" }); return false; }
  const run = async () => {
    await storageReady;
    if (message.type === "PR_GET_PUBLIC_CONFIG") return { ok: true, ...(await publicConfig()) };
    if (message.type === "PR_GET_SETTINGS") {
      const value = await stored();
      const settings = lenient(value);
      return {
        ok: true,
        settings: {
          engine: settings.engine,
          gemini: { model: settings.gemini.model, hasKey: Boolean(settings.gemini.apiKey), freeTierConfirmed: settings.gemini.freeTierConfirmed },
          models: Object.entries(ParallelReadConfig.GEMINI_MODELS).map(([id, model]) => ({ id, label: model.label }))
        }
      };
    }
    if (message.type === "PR_SAVE_SETTINGS") return serializeMutation(() => saveSettings(message.settings));
    if (message.type === "PR_CLEAR_KEY") {
      return serializeMutation(async () => {
        const value = await stored();
        resetEngine();
        await chrome.storage.local.set({
          [STORAGE_KEY]: { engine: value.engine, gemini: { ...value.gemini, apiKey: "", freeTierConfirmed: false }, revision: crypto.randomUUID() }
        });
        return { ok: true, publicConfig: await publicConfig() };
      });
    }
    if (message.type === "PR_TEST_CONNECTION") {
      const translator = await engine();
      const [result] = await translator.translateBatch([{ text: TEST_SENTENCE, literals: [] }], {});
      if (!result.ok) throw problem(result.code === "SIMPLIFIED_OUTPUT" || result.code === "PLACEHOLDER_MISMATCH" ? "INVALID_RESPONSE" : result.code, result.error);
      return { ok: true, source: TEST_SENTENCE, text: result.text, engineLabel: (await publicConfig()).engineLabel };
    }
    const request = translationRequest(message);
    const translator = await engine(typeof message.revision === "string" ? message.revision : "");
    const results = await translator.translateBatch(request.segments, request.context);
    return { ok: true, results };
  };
  run().then(sendResponse, error => {
    const known = KNOWN_ERRORS.has(error?.code);
    sendResponse({ ok: false, code: known ? error.code : "TRANSLATION_FAILED", error: known ? error.message : "無法完成操作，請確認設定後再試。" });
  });
  return true;
});
