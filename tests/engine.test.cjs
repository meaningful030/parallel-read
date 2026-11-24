"use strict";
// Engine behaviour with MOCKED service responses. These tests check request
// format, safety and error handling. They cannot measure real translation quality.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
require(path.join(__dirname, "../extension/engine.js"));
const { createGoogleEngine, createGeminiEngine, internals } = globalThis.ParallelReadEngine;

const KEY = "qa-only-not-a-real-key";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const queries = options => new URLSearchParams(options.body).getAll("q");
const google = (fetcher, extra = {}) => createGoogleEngine(fetcher, { minIntervalMs: 0, ...extra });
const gemini = (fetcher, extra = {}) => createGeminiEngine(fetcher, { config: { apiKey: KEY, model: "gemini-3.8-flash", thinkingLevel: "low" }, ...extra });
const geminiReply = (translations, extra = {}) => json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ translations }) }] }, ...extra }] });
const echoGemini = async (url, options) => {
  const payload = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
  return geminiReply(payload.segments.map(segment => ({ id: segment.id, text: "譯：" + segment.text })));
};

// --- Google ------------------------------------------------------------------

test("Google: one POST per batch to the fixed endpoint, no credentials or referrer", async () => {
  let request;
  const engine = google(async (url, options) => { request = { url, options }; return json(["第一段。", "第二段。"]); });
  const results = await engine.translateBatch([{ text: "First paragraph.", literals: [] }, { text: "Second paragraph.", literals: [] }]);
  assert.deepEqual(results, [{ ok: true, text: "第一段。" }, { ok: true, text: "第二段。" }]);
  assert.equal(request.url, "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-TW&format=text");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(queries(request.options), ["First paragraph.", "Second paragraph."]);
  for (const [key, expected] of Object.entries({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" })) assert.equal(request.options[key], expected);
  assert.equal(request.options.headers.Authorization, undefined);
});

test("Google: inline code is sent as placeholders and restored verbatim", async () => {
  let sent;
  const engine = google(async (url, options) => { sent = queries(options); return json(["使用 [[1]] 選項呼叫 [[0]]，以便取消請求。"]); });
  const [result] = await engine.translateBatch([{ text: "Call [[0]] with the [[1]] option so that the request can be cancelled.", literals: ["fetch()", "signal"] }]);
  assert.equal(result.text, "使用 signal 選項呼叫 fetch()，以便取消請求。");
  assert.ok(!sent[0].includes("fetch()") && !sent[0].includes("signal"), "code literals must not be sent for translation");
});

test("Google: a lost placeholder is retried once with code inlined", async () => {
  const calls = [];
  const engine = google(async (url, options) => {
    calls.push(queries(options));
    return calls.length === 1 ? json(["使用選項呼叫 [[0]]。"]) : json(["使用 signal 選項呼叫 fetch()。"]);
  });
  const [result] = await engine.translateBatch([{ text: "Call [[0]] with the [[1]] option.", literals: ["fetch()", "signal"] }]);
  assert.deepEqual(result, { ok: true, text: "使用 signal 選項呼叫 fetch()。" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["Call fetch() with the signal option."]);
});

test("Google: Simplified Chinese output is retried once, then refused for that paragraph only", async () => {
  let calls = 0;
  const engine = google(async (url, options) => {
    calls++;
    return json(queries(options).map(text => text.startsWith("Bad") ? "这家芯片制造商的股价下跌了。" : "這段是正體中文。"));
  });
  const results = await engine.translateBatch([{ text: "Good paragraph.", literals: [] }, { text: "Bad paragraph.", literals: [] }]);
  assert.deepEqual(results[0], { ok: true, text: "這段是正體中文。" });
  assert.equal(results[1].ok, false);
  assert.equal(results[1].code, "SIMPLIFIED_OUTPUT");
  assert.equal(calls, 2, "exactly one bounded retry");
  assert.equal(internals.looksSimplified("這家晶片製造商的股價在早盤交易中下跌了 8%。"), false);
  assert.equal(internals.looksSimplified("这家芯片制造商的股价在早盘交易中下跌了 8%。"), true);
});

test("Google: Mainland-only computing terms become Taiwan terms, code literals untouched", async () => {
  const engine = google(async () => json(["如果您不希望在選項卡之間共用緩存，請將 [[0]] 設定為默認的訪問令牌。"]));
  const [result] = await engine.translateBatch([{ text: "If you do not want to share the cache between tabs, set [[0]] to the default access token.", literals: ["軟件.cache"] }]);
  assert.equal(result.text, "如果您不希望在分頁之間共用快取，請將 軟件.cache 設定為預設的存取令牌。");
  assert.equal(internals.taiwanize("列車運行正常，文件已寄出。"), "列車運行正常，文件已寄出。", "ambiguous words are never rewritten");
});

test("Google: throttling and server errors stop immediately without retries or leaks", async () => {
  for (const [status, code] of [[429, "RATE_LIMITED"], [403, "RATE_LIMITED"], [500, "SERVICE_ERROR"], [503, "SERVICE_ERROR"]]) {
    let calls = 0;
    const engine = google(async () => { calls++; return { ok: false, status, json: async () => { throw Error("should not read body"); } }; });
    await assert.rejects(engine.translateBatch([{ text: "Sensitive source sentence.", literals: [] }]), error => error.code === code && !error.message.includes("Sensitive"));
    assert.equal(calls, 1);
  }
  await assert.rejects(google(async () => json(["只有一段"])).translateBatch([{ text: "One.", literals: [] }, { text: "Two.", literals: [] }]), error => error.code === "INVALID_RESPONSE");
  await assert.rejects(google(async () => { throw Error("secret source and url"); }).translateBatch([{ text: "Offline.", literals: [] }]), error => error.code === "NETWORK" && !error.message.includes("secret"));
});

test("Google: cache avoids repeat requests; invalid input sends nothing", async () => {
  let calls = 0;
  const engine = google(async (url, options) => { calls++; return json(queries(options).map(() => "譯文")); });
  await engine.translateBatch([{ text: "Same paragraph.", literals: [] }]);
  await engine.translateBatch([{ text: "Same paragraph.", literals: [] }, { text: "New paragraph.", literals: [] }]);
  assert.equal(calls, 2);
  await assert.rejects(engine.translateBatch([{ text: "  ", literals: [] }]), error => error.code === "INVALID_TEXT");
  await assert.rejects(engine.translateBatch([{ text: "A".repeat(4001), literals: [] }]), error => error.code === "TEXT_TOO_LONG");
  await assert.rejects(engine.translateBatch([]), error => error.code === "INVALID_TEXT");
  assert.equal(calls, 2);
});

test("Google: requests run one at a time with spacing", async () => {
  let active = 0, peak = 0;
  const starts = [];
  const engine = createGoogleEngine(async (url, options) => {
    starts.push(Date.now()); active++; peak = Math.max(peak, active);
    await sleep(5); active--;
    return json(queries(options).map(() => "譯文"));
  }, { minIntervalMs: 40 });
  await Promise.all(["A one.", "B two.", "C three."].map(text => engine.translateBatch([{ text, literals: [] }])));
  assert.equal(peak, 1);
  assert.ok(starts[1] - starts[0] >= 35 && starts[2] - starts[1] >= 35, JSON.stringify(starts));
});

test("Google: dispose aborts in-flight work, drops queued work and blocks late output", async () => {
  let calls = 0, aborted = 0;
  const engine = google((url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener("abort", () => { aborted++; reject(new DOMException("cancelled", "AbortError")); });
  }));
  const jobs = [1, 2, 3].map(n => engine.translateBatch([{ text: "Pending " + n, literals: [] }]));
  await sleep(5);
  engine.dispose();
  const results = await Promise.allSettled(jobs);
  assert.equal(calls, 1, "queued batches never reach the service");
  assert.equal(aborted, 1);
  assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "ABORTED"));
  await assert.rejects(engine.translateBatch([{ text: "After dispose", literals: [] }]), error => error.code === "ABORTED");

  let release;
  const late = google(async () => { await new Promise(resolve => { release = resolve; }); return json(["過時的譯文"]); });
  const pending = late.translateBatch([{ text: "Late.", literals: [] }]);
  await sleep(5);
  late.dispose();
  release();
  await assert.rejects(pending, error => error.code === "ABORTED");
});

test("Google: timeout covers the response body", async () => {
  const engine = google(async (url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("stalled", "AbortError"))))
  }), { timeoutMs: 10 });
  await assert.rejects(engine.translateBatch([{ text: "Slow body.", literals: [] }]), error => error.code === "TIMEOUT");
});

// --- Gemini ------------------------------------------------------------------

test("Gemini: key only in x-goog-api-key header; documented generateContent body", async () => {
  let request;
  const engine = gemini(async (url, options) => { request = { url, options }; return echoGemini(url, options); });
  const results = await engine.translateBatch(
    [{ text: "Call [[0]] now.", literals: ["fetch()"] }, { text: "It agreed.", literals: [] }],
    { title: "T".repeat(300), section: "Auth", previous: { source: "The council met.", translation: "市議會開會。" }, next: "N".repeat(900) }
  );
  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(request.options.headers["x-goog-api-key"], KEY);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.ok(!request.url.includes(KEY) && !request.options.body.includes(KEY));
  const body = JSON.parse(request.options.body);
  assert.match(body.systemInstruction.parts[0].text, /Taiwan/);
  assert.match(body.systemInstruction.parts[0].text, /untrusted/);
  assert.match(body.systemInstruction.parts[0].text, /as much as/);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "low" });
  assert.equal(body.generationConfig.temperature, undefined, "temperature is deprecated for current Gemini models");
  assert.ok(body.generationConfig.responseJsonSchema.properties.translations);
  const payload = JSON.parse(body.contents[0].parts[0].text);
  assert.equal(payload.title.length, 160);
  assert.equal(payload.next.length, 400);
  assert.deepEqual(payload.previous, { source: "The council met.", translation: "市議會開會。" });
  assert.deepEqual(payload.segments, [{ id: "s1", text: "Call [[0]] now.", code: { 0: "fetch()" } }, { id: "s2", text: "It agreed." }]);
  assert.deepEqual(results, [{ ok: true, text: "譯：Call fetch() now." }, { ok: true, text: "譯：It agreed." }]);
});

test("Gemini: Flash-Lite keeps its default thinking level", async () => {
  let body;
  const engine = createGeminiEngine(async (url, options) => { body = JSON.parse(options.body); return echoGemini(url, options); }, { config: { apiKey: KEY, model: "gemini-3.5-flash-lite", thinkingLevel: "" } });
  await engine.translateBatch([{ text: "Hello there.", literals: [] }]);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

test("Gemini: thought parts are ignored and ids may arrive in any order", async () => {
  const engine = gemini(async () => json({ candidates: [{ finishReason: "STOP", content: { parts: [
    { text: "thinking about it", thought: true },
    { text: JSON.stringify({ translations: [{ id: "s2", text: "第二。" }, { id: "s1", text: "第一。" }] }) }
  ] } }] }));
  const results = await engine.translateBatch([{ text: "First.", literals: [] }, { text: "Second.", literals: [] }]);
  assert.deepEqual(results.map(result => result.text), ["第一。", "第二。"]);
});

test("Gemini: mismatched, truncated or filtered output is rejected and not cached", async () => {
  const bad = [
    geminiReply([{ id: "s1", text: "只有一段" }]),
    geminiReply([{ id: "s1", text: "一" }, { id: "s1", text: "重複" }]),
    geminiReply([{ id: "s1", text: "一" }, { id: "s9", text: "多出" }]),
    json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] }),
    json({ candidates: [] })
  ];
  for (const response of bad) {
    await assert.rejects(gemini(async () => response).translateBatch([{ text: "One.", literals: [] }, { text: "Two.", literals: [] }]), error => error.code === "INVALID_RESPONSE");
  }
  for (const [reply, code] of [
    [{ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }] }, "INCOMPLETE_RESPONSE"],
    [{ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }, "CONTENT_FILTERED"],
    [{ promptFeedback: { blockReason: "SAFETY" } }, "CONTENT_FILTERED"]
  ]) {
    let calls = 0;
    const engine = gemini(async (url, options) => ++calls === 1 ? json(reply) : echoGemini(url, options));
    await assert.rejects(engine.translateBatch([{ text: "Source.", literals: [] }]), error => error.code === code);
    assert.equal((await engine.translateBatch([{ text: "Source.", literals: [] }]))[0].ok, true);
    assert.equal(calls, 2);
  }
});

test("Gemini: quota, key and eligibility errors are explained without leaking provider text", async () => {
  const body = (status, details) => ({ error: { code: 0, status, message: "provider says " + KEY, details } });
  const cases = [
    [400, body("INVALID_ARGUMENT", [{ reason: "API_KEY_INVALID" }]), "AUTH_INVALID"],
    [429, body("RESOURCE_EXHAUSTED", [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "0" }] }]), "FREE_TIER_UNAVAILABLE"],
    [429, body("RESOURCE_EXHAUSTED", [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }]), "QUOTA_EXHAUSTED"],
    [429, body("RESOURCE_EXHAUSTED", [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "5" }] }]), "RATE_LIMITED"],
    [400, body("FAILED_PRECONDITION", []), "FREE_TIER_UNAVAILABLE"],
    [403, body("PERMISSION_DENIED", []), "PERMISSION_DENIED"],
    [404, body("NOT_FOUND", []), "MODEL_NOT_FOUND"],
    [503, body("UNAVAILABLE", []), "SERVICE_BUSY"],
    [500, "not json", "SERVICE_ERROR"]
  ];
  for (const [status, data, code] of cases) {
    let calls = 0;
    const engine = gemini(async () => { calls++; return { ok: false, status, json: async () => { if (typeof data === "string") throw SyntaxError(data); return data; } }; });
    await assert.rejects(engine.translateBatch([{ text: "Sensitive source.", literals: [] }]), error =>
      error.code === code && !error.message.includes(KEY) && !error.message.includes("provider says") && !error.message.includes("Sensitive"));
    assert.equal(calls, 1, "no automatic retry for " + code);
  }
});

test("Gemini: context is part of the cache key; missing key sends nothing", async () => {
  let calls = 0;
  const engine = gemini(async (url, options) => { calls++; return echoGemini(url, options); });
  await engine.translateBatch([{ text: "The lead.", literals: [] }], { title: "Chemistry" });
  await engine.translateBatch([{ text: "The lead.", literals: [] }], { title: "Chemistry" });
  await engine.translateBatch([{ text: "The lead.", literals: [] }], { title: "Newsroom" });
  assert.equal(calls, 2);
  let none = 0;
  await assert.rejects(createGeminiEngine(async () => { none++; }, { config: { apiKey: "", model: "gemini-3.8-flash" } }).translateBatch([{ text: "Hi there.", literals: [] }]), error => error.code === "SETTINGS_REQUIRED");
  assert.equal(none, 0);
});

test("Gemini: dispose cancels the in-flight request and rejects queued batches", async () => {
  let calls = 0;
  const engine = gemini((url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
  }));
  const jobs = [1, 2].map(n => engine.translateBatch([{ text: "Batch " + n, literals: [] }]));
  await sleep(5);
  engine.dispose();
  const results = await Promise.allSettled(jobs);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "ABORTED"));
});
