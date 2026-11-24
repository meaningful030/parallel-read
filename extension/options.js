"use strict";
(() => {
  const byId = id => document.getElementById(id);
  const form = byId("settings-form");
  const radios = [...document.querySelectorAll('input[name="engine"]')];
  const modelSelect = byId("model");
  const keyInput = byId("api-key");
  const confirmed = byId("free-tier-confirmed");
  const saveButton = byId("save-settings");
  const testButton = byId("test-connection");
  const clearButton = byId("clear-key");
  let loaded = false;
  let busy = "load";
  let saved = { engine: "google", model: "gemini-3.8-flash", hasKey: false, freeTierConfirmed: false };

  function message(type, extra = {}) { return chrome.runtime.sendMessage({ type, ...extra }); }
  function checkReply(reply) {
    if (!reply?.ok) throw new Error(reply?.error || "無法完成操作，請稍後再試。");
    return reply;
  }
  function feedback(text = "", kind = "success") {
    byId("success-message").hidden = true;
    byId("error-message").hidden = true;
    if (!text) return;
    const target = byId(kind === "error" ? "error-message" : "success-message");
    target.textContent = text;
    target.hidden = false;
  }
  const selectedEngine = () => radios.find(radio => radio.checked)?.value || "google";
  const unsaved = () => selectedEngine() !== saved.engine || modelSelect.value !== saved.model
    || Boolean(keyInput.value.trim()) || confirmed.checked !== saved.freeTierConfirmed;
  const savedReady = () => saved.engine === "google" || (saved.hasKey && saved.freeTierConfirmed);

  function render() {
    const disabled = Boolean(busy) || !loaded;
    form.setAttribute("aria-busy", String(Boolean(busy)));
    form.classList.toggle("is-loading", Boolean(busy));
    for (const control of [...radios, modelSelect, keyInput, confirmed, saveButton]) control.disabled = disabled;
    testButton.disabled = disabled || !savedReady();
    clearButton.disabled = disabled || !saved.hasKey;
    byId("gemini-settings").hidden = selectedEngine() !== "gemini";
    byId("key-management").hidden = !saved.hasKey && selectedEngine() !== "gemini";
    saveButton.textContent = busy === "save" ? "正在保存…" : "保存設定";
    testButton.textContent = busy === "test" ? "正在測試…" : "測試翻譯";
    clearButton.textContent = busy === "clear" ? "正在清除…" : "清除金鑰";
    const state = byId("credential-state");
    const label = saved.engine === "gemini" ? (ParallelReadConfig.GEMINI_MODELS[saved.model]?.label || "Gemini") : "Google 翻譯";
    state.textContent = !loaded ? "尚未載入" : savedReady() ? "使用中：" + label : "Gemini 尚未設定";
    state.classList.toggle("ready", loaded && savedReady());
    keyInput.placeholder = saved.hasKey ? "已保存金鑰；留空可保留原有金鑰" : "貼上 Gemini API Key";
    byId("key-help").textContent = saved.hasKey
      ? "已保存的金鑰不會顯示在頁面上；留空可繼續使用原有金鑰。"
      : "請使用未啟用帳單的免費方案專案金鑰。";
  }
  function setBusy(value) { busy = value; render(); }
  function report(error) { feedback(error?.message || "無法完成操作，請稍後再試。", "error"); }

  radios.forEach(radio => radio.addEventListener("change", () => { feedback(); render(); }));

  // Permission for the chosen service's fixed origin is requested synchronously
  // inside this click, as Chrome requires.
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !loaded) return;
    feedback();
    byId("test-result").hidden = true;
    try {
      const engine = selectedEngine();
      const settings = ParallelReadConfig.normalize({
        engine, gemini: { apiKey: keyInput.value, model: modelSelect.value, freeTierConfirmed: confirmed.checked }
      }, { requireReady: false });
      if (engine === "gemini") {
        if (!settings.gemini.apiKey && !saved.hasKey) throw new Error("請先貼上 Gemini API Key。");
        if (!settings.gemini.freeTierConfirmed) throw new Error("請先確認專案是免費方案且未啟用帳單，再勾選確認欄位。");
      }
      const permission = chrome.permissions.request({ origins: [ParallelReadConfig.originPattern(engine)] });
      setBusy("save");
      finishSave(permission, settings);
    } catch (error) { setBusy(""); report(error); }
  });

  async function finishSave(permission, settings) {
    try {
      if (!await permission) throw new Error("尚未允許連線到所選的翻譯服務，設定未保存。請再按一次「保存設定」並允許存取。");
      const reply = checkReply(await message("PR_SAVE_SETTINGS", { settings }));
      saved = {
        engine: settings.engine, model: settings.gemini.model,
        hasKey: saved.hasKey || Boolean(settings.gemini.apiKey), freeTierConfirmed: settings.gemini.freeTierConfirmed
      };
      keyInput.value = "";
      feedback(`設定已保存，現在使用「${reply.publicConfig?.engineLabel || "所選服務"}」。已開啟雙語閱讀的分頁，按「重新嘗試」會以新設定重新翻譯。`);
    } catch (error) { report(error); }
    finally { setBusy(""); }
  }

  testButton.addEventListener("click", async () => {
    if (busy || !loaded) return;
    feedback();
    byId("test-result").hidden = true;
    if (unsaved()) { feedback("目前有尚未保存的變更，請先保存設定，再測試。", "error"); return; }
    setBusy("test");
    try {
      const reply = checkReply(await message("PR_TEST_CONNECTION"));
      byId("test-result-label").textContent = "測試譯文 · " + (reply.engineLabel || "");
      byId("test-source").textContent = reply.source || "";
      byId("test-result-text").textContent = reply.text || "";
      byId("test-result").hidden = false;
      feedback("翻譯服務可以使用。回到英文網頁即可開始雙語閱讀。");
    } catch (error) { report(error); }
    finally { setBusy(""); }
  });

  clearButton.addEventListener("click", async () => {
    if (busy || !loaded || !saved.hasKey) return;
    feedback();
    byId("test-result").hidden = true;
    setBusy("clear");
    try {
      checkReply(await message("PR_CLEAR_KEY"));
      saved = { ...saved, hasKey: false, freeTierConfirmed: false };
      confirmed.checked = false;
      keyInput.value = "";
      feedback("本機保存的金鑰已清除，排隊中的 Gemini 請求也已取消。這不會撤銷 Google AI Studio 裡的金鑰本身。");
    } catch (error) { report(error); }
    finally { setBusy(""); }
  });

  async function initialize() {
    try {
      const reply = checkReply(await message("PR_GET_SETTINGS"));
      const settings = reply.settings || {};
      saved = {
        engine: settings.engine === "gemini" ? "gemini" : "google",
        model: settings.gemini?.model || "gemini-3.8-flash",
        hasKey: settings.gemini?.hasKey === true,
        freeTierConfirmed: settings.gemini?.freeTierConfirmed === true
      };
      modelSelect.replaceChildren(...(settings.models || []).map(model => new Option(model.label, model.id)));
      modelSelect.value = saved.model;
      radios.forEach(radio => { radio.checked = radio.value === saved.engine; });
      confirmed.checked = saved.freeTierConfirmed;
      loaded = true;
    } catch (error) { report(error); }
    finally { setBusy(""); }
  }
  initialize();
})();
