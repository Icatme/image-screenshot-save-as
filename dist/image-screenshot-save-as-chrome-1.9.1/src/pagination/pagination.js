import { getTranslator } from "../lib/i18n.js";
import { getSettings } from "../lib/settings.js";
import { getScreenshotPagePlan } from "../lib/screenshot-pagination.js";
import { loadScreenshotDirectory, storeScreenshotDirectory } from "../lib/screenshot-directory.js";

const requestKey = "screenshotPaginationRequest";
const requestId = location.hash.slice(1);
const controls = document.querySelector("#controls");
const saveButton = document.querySelector("#save");
const cancelButton = document.querySelector("#cancel");
const status = document.querySelector("#status");
let t = (key) => chrome.i18n.getMessage(key) || key;
let directory;
let request;
let busy = false;
let finished = false;

document.querySelector("#form").addEventListener("submit", save);
document.querySelector("#choose-directory").addEventListener("click", chooseDirectory);
controls.addEventListener("change", updateSaveButton);
cancelButton.addEventListener("click", cancel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !busy) void cancel();
});
chrome.storage.onChanged.addListener((changes, area) => {
  const current = changes[requestKey]?.newValue;
  if (area === "session" && current?.id === requestId && ["interrupted", "completed"].includes(current.status)) {
    showFinished(current);
  }
});
void initialize().catch((error) => showError(error));

async function initialize() {
  const translator = await getTranslator((await getSettings()).localeOverride);
  t = translator.t;
  document.documentElement.lang = translator.locale.replace("_", "-");
  document.title = t("paginationTitle");
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  request = await getCurrentRequest();
  if (["interrupted", "completed"].includes(request.status)) {
    showFinished(request);
    return;
  }
  if (request.status !== "choosing") {
    throw new Error(t("paginationExpired"));
  }
  document.querySelector("#intro").textContent = t("paginationOversized");
  document.querySelector("#dimensions").textContent = `${request.width} × ${request.height} px · ${request.format.toUpperCase()}`;
  for (const mode of ["longest", "a4"]) {
    const input = document.querySelector(`input[value="${mode}"]`);
    const label = document.querySelector(`#${mode}-count`);
    try {
      const plan = getScreenshotPagePlan({ ...request, mode });
      label.textContent = t("paginationPageCount", [String(plan.pageCount), String(plan.width), String(plan.pageHeight)]);
    } catch {
      input.disabled = true;
      label.textContent = t("paginationModeUnavailable");
    }
  }
  document.querySelector("#copy-note").hidden = request.action !== "copy-path";
  directory = await loadScreenshotDirectory();
  showDirectory();
  controls.disabled = false;
  updateSaveButton();
}

function showDirectory() {
  document.querySelector("#directory-name").textContent = directory?.name || t("paginationNoDirectory");
  document.querySelector("#choose-directory").textContent = t(directory ? "paginationChangeDirectory" : "paginationChooseDirectory");
}

function updateSaveButton() {
  saveButton.disabled = busy || finished || !directory || !document.querySelector('input[name="mode"]:checked:not(:disabled)');
}

async function chooseDirectory() {
  try {
    // Call the picker directly from this click so transient user activation is retained.
    const selected = await window.showDirectoryPicker({
      id: "screenshot-pages", mode: "readwrite", startIn: directory || "downloads",
    });
    await storeScreenshotDirectory(selected);
    directory = selected;
    showDirectory();
    status.textContent = "";
    updateSaveButton();
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
}

async function save(event) {
  event.preventDefault();
  if (saveButton.disabled) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  busy = true;
  controls.disabled = true;
  cancelButton.disabled = true;
  updateSaveButton();
  try {
    if (await directory.requestPermission({ mode: "readwrite" }) !== "granted") {
      throw new Error(t("paginationDirectoryPermission"));
    }
    // Persist again so this request uses the folder shown here, even if another
    // chooser previously changed the remembered folder.
    await storeScreenshotDirectory(directory);
    status.dataset.error = "false";
    status.textContent = t("paginationCapturing");
    const result = await chrome.runtime.sendMessage({ type: "SAVE_PAGED_SCREENSHOT", requestId, mode });
    if (!result?.ok) throw new Error(result?.error || t("errorUnknown"));
    status.textContent = t(result.partial ? "paginationSavedPartial" : "paginationSaved", [String(result.savedCount), result.directoryName]);
    finished = true;
  } catch (error) {
    showError(error);
    // A disconnected message port can mean the worker stopped. This status
    // request wakes its replacement and waits for recovery before reading state.
    try {
      const current = await getCurrentRequest();
      if (["interrupted", "completed"].includes(current.status)) showFinished(current);
      finished = current.status !== "choosing";
    } catch {
      finished = true;
    }
  } finally {
    busy = false;
    controls.disabled = finished;
    cancelButton.disabled = false;
    if (finished) cancelButton.textContent = t("paginationClose");
    updateSaveButton();
  }
}

async function cancel() {
  if (busy) return;
  try {
    const current = (await chrome.storage.session.get(requestKey))[requestKey];
    if (current?.id === requestId && ["choosing", "interrupted", "completed"].includes(current.status)) {
      await chrome.storage.session.remove(requestKey);
    }
    window.close();
  } catch (error) {
    showError(error);
  }
}

async function getCurrentRequest() {
  const result = await chrome.runtime.sendMessage({ type: "GET_PAGED_SCREENSHOT_STATUS", requestId });
  if (!result?.ok) throw new Error(result?.error || t("paginationExpired"));
  return result.request;
}

function showFinished(current) {
  finished = true;
  busy = false;
  controls.disabled = true;
  cancelButton.disabled = false;
  cancelButton.textContent = t("paginationClose");
  status.dataset.error = String(current.status === "interrupted" || Boolean(current.partial));
  const message = current.status === "interrupted" ? "paginationInterrupted"
    : current.partial ? "paginationSavedPartial" : "paginationSaved";
  status.textContent = t(message, [String(current.savedCount || 0), current.directoryName || ""]);
  if (current.pendingFilename) {
    status.textContent += ` ${t("paginationUnconfirmedPage", current.pendingFilename)}`;
  }
  updateSaveButton();
}

function showError(error) {
  status.dataset.error = "true";
  status.textContent = error.message || String(error);
}
