"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const button = byId("translate");
  const label = byId("button-label");
  const restore = byId("restore");
  const status = byId("status");
  const dot = byId("status-dot");
  const count = byId("count");
  const error = byId("error");
  const progressTrack = byId("progress-track");
  const progress = byId("progress");
  let tabId;
  let state = { active: false };
  let busy = false;
  let supported = true;
  let polling;
  let closed = false;
  let apiReady = false;
  let config = {};

  function showError(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }

  function render(next) {
    state = next || { active: false };
    const total = Number(state.total) || 0;
    const translated = Number(state.translated) || 0;
    const failed = Number(state.failed) || 0;
    const active = Boolean(state.active);
    const running = Boolean(state.running);
    const canRetry = active && !running && (failed > 0 || Boolean(state.error));
    button.disabled = busy || !supported || (active && !canRetry);
    label.textContent = !apiReady ? "先完成翻譯設定" : canRetry ? "重新嘗試" : active ? (running ? "正在翻譯…" : "已開啟雙語閱讀") : "翻譯這個網頁";
    if (!apiReady && supported && !busy) button.disabled = false;
    restore.hidden = !active;
    restore.disabled = busy;
    dot.classList.toggle("running", running);
    dot.classList.toggle("warning", failed > 0 || Boolean(state.error));
    count.textContent = active && total ? `${translated} / ${total} 段` : "";
    progressTrack.hidden = !running || total === 0;
    progress.style.width = `${total ? Math.min(100, ((translated + failed) / total) * 100) : 0}%`;
    if (running) status.textContent = translated ? "正在逐段翻譯…" : "正在準備翻譯…";
    else if (active && translated && failed) status.textContent = `已翻譯，${failed} 段暫時無法完成。`;
    else if (active && translated) status.textContent = "雙語閱讀已開啟。";
    else if (active && total === 0 && !state.error) status.textContent = "這個網頁沒有找到英文段落。";
    else if (active && failed) status.textContent = "翻譯暫時無法完成。";
    else status.textContent = "準備好，開始閱讀。";
    if (!apiReady && !active) status.textContent = config.reason || "請先完成翻譯服務設定。";
    byId("hint").textContent = active ? "捲動網頁時，會繼續翻譯新的段落。" : "保留原文與連結，隨時可以還原。";
    showError(state.error || "");
  }

  function message(type) {
    return chrome.tabs.sendMessage(tabId, { type });
  }

  async function pollStatus() {
    if (closed || busy || !supported || tabId === undefined) return;
    try {
      const next = await message("PR_STATUS");
      if (next && !closed && !busy) render(next);
    } catch {
      // A new page has no content script until the user asks to translate it.
      if (state.active && !closed && !busy) render({ active: false });
    }
  }

  async function ensureContentScript() {
    try {
      const current = await message("PR_STATUS");
      if (current) return;
    } catch {
      // Inject only after this explicit click, under the activeTab grant.
    }
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }

  async function perform(stopping) {
    if (busy || !supported || tabId === undefined) return;
    if (!stopping && !apiReady) { await chrome.runtime.openOptionsPage(); return; }
    busy = true;
    button.disabled = true;
    restore.disabled = true;
    showError("");
    try {
      if (!stopping) await ensureContentScript();
      const next = await message(stopping ? "PR_STOP" : "PR_START");
      busy = false;
      render(next);
      if (!stopping && next?.needsSettings) await chrome.runtime.openOptionsPage();
    } catch (cause) {
      busy = false;
      render(state);
      const detail = String(cause?.message || "");
      showError(/file:|file URL/i.test(detail)
        ? "請先在擴充功能的詳細資料開啟「允許存取檔案網址」，或改用一般英文網站。"
        : "目前頁面無法翻譯。請切換到一般英文網站；若剛更新擴充功能，請重新整理網頁後再試。" );
    }
  }

  button.addEventListener("click", () => perform(false));
  restore.addEventListener("click", () => perform(true));

  byId("demo").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("demo.html") });
  });
  byId("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

  async function initialize() {
    try {
      config = (await chrome.runtime.sendMessage({ type: "PR_GET_PUBLIC_CONFIG" })) || {};
      apiReady = Boolean(config.ok && config.ready);
      byId("edition").textContent = config.engine === "gemini" ? "Gemini" : "Google 翻譯";
      byId("privacy").textContent = config.engine === "gemini"
        ? `使用 ${config.engineLabel || "Gemini"}。翻譯時會把英文段落、網頁標題與少量前後文傳送到 Google Gemini；免費額度有限，用完會停止。`
        : "使用 Google 翻譯（免金鑰的公開介面，非正式 API）。翻譯時會把英文段落傳送到 Google；短時間翻譯太多段可能被暫時限制。";
      render(state);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
      const url = tab?.url || "";
      const ownDemoUrl = new URL(chrome.runtime.getURL("demo.html"));
      let ownDemo = false;
      try {
        const currentUrl = new URL(url);
        ownDemo = currentUrl.protocol === ownDemoUrl.protocol
          && currentUrl.host === ownDemoUrl.host
          && currentUrl.pathname === ownDemoUrl.pathname;
      } catch {
        // An empty or temporary tab URL is handled as an unsupported page below.
      }
      if (ownDemo) {
        supported = false;
        button.disabled = true;
        label.textContent = "前往試讀頁操作";
        status.textContent = "試讀頁已開啟。";
        byId("hint").textContent = "請使用試讀頁右上方的「開始雙語閱讀」與「還原網頁」。";
        showError("");
        return;
      }
      supported = tabId !== undefined && /^(https?:|file:)/i.test(url)
        && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(url);
      if (!supported) {
        button.disabled = true;
        status.textContent = "請先開啟一個英文網頁。";
        showError("Chrome 內建頁面、擴充功能商店與 PDF 檢視器無法直接翻譯。可先點下方的「試讀範例」。");
        return;
      }
      await pollStatus();
      polling = setInterval(pollStatus, 800);
    } catch {
      supported = false;
      button.disabled = true;
      showError("無法讀取目前分頁，請關閉此面板後再開啟。");
    }
  }

  window.addEventListener("pagehide", () => {
    closed = true;
    clearInterval(polling);
  });
  initialize();
})();
