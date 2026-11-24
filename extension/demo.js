"use strict";
// Outside the installed extension, keep the example readable and explain setup.
if (!globalThis.chrome?.runtime?.id) {
  document.getElementById("demo-translate").disabled = true;
  document.getElementById("demo-status").textContent = "請先安裝雙語讀，再從擴充功能面板開啟「試讀範例」。";
}
