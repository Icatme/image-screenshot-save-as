import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../lib/settings.js";

const SAVE_HISTORY_KEY = "saveHistory";

const form = document.getElementById("settings-form");
const jpgQualityInput = document.getElementById("jpg-quality");
const webpQualityInput = document.getElementById("webp-quality");
const silentSaveInput = document.getElementById("silent-save");
const jpgQualityValue = document.getElementById("jpg-quality-value");
const webpQualityValue = document.getElementById("webp-quality-value");
const resetButton = document.getElementById("reset-button");
const openHistoryButton = document.getElementById("open-history-button");
const closeHistoryButton = document.getElementById("close-history-button");
const clearHistoryButton = document.getElementById("clear-history-button");
const historyDialog = document.getElementById("history-dialog");
const status = document.getElementById("status");
const historyList = document.getElementById("history-list");

void initialize();

async function initialize() {
  const settings = await getSettings();
  applySettings(settings);
  await renderHistory();

  jpgQualityInput.addEventListener("input", () => {
    jpgQualityValue.textContent = Number(jpgQualityInput.value).toFixed(2);
  });

  webpQualityInput.addEventListener("input", () => {
    webpQualityValue.textContent = Number(webpQualityInput.value).toFixed(2);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const saved = await saveSettings({
      jpgQuality: jpgQualityInput.value,
      webpQuality: webpQualityInput.value,
      silentSave: silentSaveInput.checked
    });

    applySettings(saved);
    setStatus("设置已保存。");
  });

  resetButton.addEventListener("click", async () => {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    applySettings(saved);
    setStatus("已恢复默认设置。");
  });

  clearHistoryButton.addEventListener("click", async () => {
    await chrome.storage.local.remove(SAVE_HISTORY_KEY);
    await renderHistory();
    setStatus("历史记录已清空。");
  });

  openHistoryButton.addEventListener("click", async () => {
    await renderHistory();
    historyDialog.showModal();
  });

  closeHistoryButton.addEventListener("click", () => {
    historyDialog.close();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SAVE_HISTORY_KEY]) {
      void renderHistory();
    }
  });
}

function applySettings(settings) {
  jpgQualityInput.value = String(settings.jpgQuality);
  webpQualityInput.value = String(settings.webpQuality);
  silentSaveInput.checked = settings.silentSave;
  jpgQualityValue.textContent = settings.jpgQuality.toFixed(2);
  webpQualityValue.textContent = settings.webpQuality.toFixed(2);
}

function setStatus(message) {
  status.textContent = message;
  window.clearTimeout(setStatus.timeoutId);
  setStatus.timeoutId = window.setTimeout(() => {
    status.textContent = "";
  }, 2200);
}

async function renderHistory() {
  const stored = await chrome.storage.local.get(SAVE_HISTORY_KEY);
  const history = Array.isArray(stored[SAVE_HISTORY_KEY]) ? stored[SAVE_HISTORY_KEY] : [];

  if (history.length === 0) {
    historyList.innerHTML = '<div class="empty">还没有保存历史。执行一次保存后会显示在这里。</div>';
    return;
  }

  historyList.innerHTML = history.map((item) => {
    const finalPath = escapeHtml(item.finalPath || item.requestedPath || "");
    const meta = [
      item.format ? item.format.toUpperCase() : "",
      item.action === "copy-path" ? "已复制路径" : "仅保存",
      item.status === "interrupted" ? "中断" : "完成"
    ].filter(Boolean).join(" · ");
    const extra = item.error ? `${meta} · ${escapeHtml(item.error)}` : meta;
    const itemStatus = item.status === "interrupted" || item.error ? "error" : "success";

    return `
      <article class="list-item" data-status="${itemStatus}">
        <div class="list-head">
          <div class="list-title">${escapeHtml(extractName(finalPath))}</div>
          <div class="list-time">${escapeHtml(formatTime(item.finishedAt || item.createdAt))}</div>
        </div>
        <div class="list-message">${finalPath || "未拿到最终路径"}</div>
        <div class="list-meta">${extra}</div>
      </article>
    `;
  }).join("");
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function extractName(path) {
  if (!path) {
    return "未命名文件";
  }

  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
