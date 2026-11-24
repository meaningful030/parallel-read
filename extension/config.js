"use strict";
// Translation service settings. Only services that are free to start with are
// offered; nothing here can enable billing or switch to a paid model.
(() => {
  const GOOGLE_ORIGIN = "https://translate.googleapis.com/*";
  const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/*";

  // Models the official Gemini API pricing page listed with a Free Tier when
  // this version was prepared (checked 2026-11-08). Free limits are set per
  // project and can change; they are not a guarantee.
  const GEMINI_MODELS = Object.freeze({
    "gemini-3.8-flash": Object.freeze({ label: "Gemini 3.8 Flash（品質優先）", thinkingLevel: "low" }),
    "gemini-3.5-flash-lite": Object.freeze({ label: "Gemini 3.5 Flash-Lite（速度優先）", thinkingLevel: "" })
  });

  const ENGINES = Object.freeze({
    google: Object.freeze({
      id: "google", label: "Google 翻譯", needsKey: false, origin: GOOGLE_ORIGIN,
      batch: Object.freeze({ maxSegments: 8, maxChars: 4000 })
    }),
    gemini: Object.freeze({
      id: "gemini", label: "Gemini", needsKey: true, origin: GEMINI_ORIGIN,
      batch: Object.freeze({ maxSegments: 10, maxChars: 4500 })
    })
  });

  const defaults = Object.freeze({
    engine: "google",
    gemini: Object.freeze({ apiKey: "", model: "gemini-3.8-flash", freeTierConfirmed: false })
  });

  function problem(message) { return Object.assign(new Error(message), { code: "INVALID_SETTINGS" }); }

  function cleanKey(value) {
    const apiKey = typeof value === "string" ? value.trim() : "";
    if (apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(apiKey)) throw problem("API Key 格式有誤，請確認沒有空白或換行。");
    return apiKey;
  }

  // Accepts current settings and the 0.2.0 layout ({ endpoint, model, apiKey, freeTierConfirmed }).
  function migrate(stored) {
    if (!stored || typeof stored !== "object") return { engine: defaults.engine, gemini: { ...defaults.gemini }, revision: "" };
    if (stored.engine) return stored;
    const hadGemini = typeof stored.apiKey === "string" && stored.apiKey && stored.freeTierConfirmed === true;
    return {
      engine: hadGemini ? "gemini" : "google",
      gemini: { apiKey: stored.apiKey || "", model: defaults.gemini.model, freeTierConfirmed: stored.freeTierConfirmed === true },
      revision: stored.revision || ""
    };
  }

  // Validates settings. requireReady: the selected service must be usable now.
  function normalize(input = {}, { requireReady = true } = {}) {
    const engine = input.engine === undefined ? defaults.engine : input.engine;
    if (!Object.prototype.hasOwnProperty.call(ENGINES, engine)) throw problem("不支援這個翻譯服務。");
    const source = input.gemini || {};
    const model = source.model === undefined || source.model === "" ? defaults.gemini.model : source.model;
    if (!Object.prototype.hasOwnProperty.call(GEMINI_MODELS, model)) {
      throw problem("此版本只提供官方價格表列有免費方案的 Gemini 模型，不支援切換其他模型。");
    }
    const gemini = { apiKey: cleanKey(source.apiKey), model, freeTierConfirmed: source.freeTierConfirmed === true };
    if (requireReady && engine === "gemini") {
      if (!gemini.apiKey) throw problem("請先在設定頁填入 Gemini API Key 並保存。");
      if (!gemini.freeTierConfirmed) throw problem("請先確認金鑰所屬專案為免費方案，且未啟用帳單。");
    }
    return { engine, gemini };
  }

  function originPattern(engine) {
    if (!Object.prototype.hasOwnProperty.call(ENGINES, engine)) throw problem("不支援這個翻譯服務。");
    return ENGINES[engine].origin;
  }

  function describe(settings) {
    const engine = ENGINES[settings.engine];
    if (settings.engine === "gemini") {
      return { engine: "gemini", engineLabel: GEMINI_MODELS[settings.gemini.model].label, model: settings.gemini.model, batch: engine.batch };
    }
    return { engine: "google", engineLabel: "Google 翻譯（免金鑰）", model: "", batch: engine.batch };
  }

  globalThis.ParallelReadConfig = Object.freeze({ ENGINES, GEMINI_MODELS, defaults, migrate, normalize, originPattern, describe });
})();
