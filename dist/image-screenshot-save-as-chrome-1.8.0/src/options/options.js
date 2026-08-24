import { getTranslator } from "../lib/i18n.js";
import {
	DEFAULT_SETTINGS,
	getSettings,
	saveSettings,
} from "../lib/settings.js";

const SAVE_HISTORY_KEY = "saveHistory";
const RECENT_ACTIVITY_KEY = "recentActivity";
const AUTO_SAVE_DELAY_MS = 240;

let activeLocale = "en";
let translate = (messageName) => messageName;
let autoSaveTimeoutId = null;
let toastTimeoutId = null;
let settingsMutationQueue = Promise.resolve();

const form = document.getElementById("settings-form");
const heroEyebrow = document.getElementById("hero-eyebrow");
const heroTilePng = document.getElementById("hero-tile-png");
const heroTilePath = document.getElementById("hero-tile-path");
const heroTileLocal = document.getElementById("hero-tile-local");
const heroNote = document.getElementById("hero-note");
const sectionTagInterface = document.getElementById("section-tag-interface");
const sectionTagOutput = document.getElementById("section-tag-output");
const sectionTagBehavior = document.getElementById("section-tag-behavior");
const sectionTagRecords = document.getElementById("section-tag-records");
const panelLanguageTitle = document.getElementById("panel-language-title");
const panelLanguageBody = document.getElementById("panel-language-body");
const localeOverrideLabel = document.getElementById("locale-override-label");
const localeOverrideSelect = document.getElementById("locale-override");
const jpgQualityInput = document.getElementById("jpg-quality");
const webpQualityInput = document.getElementById("webp-quality");
const silentSaveInput = document.getElementById("silent-save");
const optionsHeading = document.getElementById("options-heading");
const optionsIntro = document.getElementById("options-intro");
const panelQualityTitle = document.getElementById("panel-quality-title");
const panelQualityBody = document.getElementById("panel-quality-body");
const jpgQualityLabel = document.getElementById("jpg-quality-label");
const webpQualityLabel = document.getElementById("webp-quality-label");
const panelSaveModeTitle = document.getElementById("panel-save-mode-title");
const panelSaveModeBody = document.getElementById("panel-save-mode-body");
const silentSaveLabel = document.getElementById("silent-save-label");
const panelHistoryTitle = document.getElementById("panel-history-title");
const panelHistoryBody = document.getElementById("panel-history-body");
const resetButton = document.getElementById("reset-button");
const openHistoryButton = document.getElementById("open-history-button");
const closeHistoryButton = document.getElementById("close-history-button");
const clearHistoryButton = document.getElementById("clear-history-button");
const historyDialog = document.getElementById("history-dialog");
const historyDialogTitle = document.getElementById("history-dialog-title");
const historyList = document.getElementById("history-list");
const activityTitle = document.getElementById("activity-title");
const activityList = document.getElementById("activity-list");
const autoSaveHint = document.getElementById("auto-save-hint");
const operationStatus = document.getElementById("operation-status");
const toast = document.getElementById("toast");

void initialize();

async function initialize() {
	bindEventListeners();
	form.setAttribute("aria-busy", "true");

	const failures = [];
	let settings = DEFAULT_SETTINGS;

	try {
		settings = await getSettings();
	} catch (error) {
		failures.push(["statusSettingsLoadFailed", error]);
	}

	try {
		await setLocale(settings.localeOverride);
	} catch (error) {
		failures.push(["statusSettingsLoadFailed", error]);
	}

	applySettings(settings);

	const records = await Promise.allSettled([renderHistory(), renderActivity()]);
	for (const result of records) {
		if (result.status === "rejected") {
			failures.push(["statusHistoryLoadFailed", result.reason]);
		}
	}

	if (failures.length > 0) {
		showOperationErrors(failures);
	}

	form.setAttribute("aria-busy", "false");
}

function bindEventListeners() {
	form.addEventListener("submit", (event) => {
		event.preventDefault();
	});

	jpgQualityInput.addEventListener("input", () => {
		updateQualityLabel(
			jpgQualityLabel,
			"labelJpgQuality",
			jpgQualityInput.value,
		);
		scheduleAutoSave();
	});

	webpQualityInput.addEventListener("input", () => {
		updateQualityLabel(
			webpQualityLabel,
			"labelWebpQuality",
			webpQualityInput.value,
		);
		scheduleAutoSave();
	});

	localeOverrideSelect.addEventListener("change", () => {
		void persistSettings({ refreshRecords: true });
	});

	silentSaveInput.addEventListener("change", () => {
		void persistSettings({ refreshRecords: false });
	});

	resetButton.addEventListener("click", () => {
		void restoreDefaults();
	});

	clearHistoryButton.addEventListener("click", () => {
		void clearHistory();
	});

	openHistoryButton.addEventListener("click", async () => {
		await refreshHistory();
		historyDialog.showModal();
	});

	closeHistoryButton.addEventListener("click", () => {
		historyDialog.close();
	});

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") {
			return;
		}

		if (changes[SAVE_HISTORY_KEY]) {
			void refreshHistory();
		}

		if (changes[RECENT_ACTIVITY_KEY]) {
			void refreshActivity();
		}
	});
}

function applySettings(settings) {
	localeOverrideSelect.value = settings.localeOverride;
	jpgQualityInput.value = String(settings.jpgQuality);
	webpQualityInput.value = String(settings.webpQuality);
	silentSaveInput.checked = settings.silentSave;
	updateQualityLabel(jpgQualityLabel, "labelJpgQuality", settings.jpgQuality);
	updateQualityLabel(
		webpQualityLabel,
		"labelWebpQuality",
		settings.webpQuality,
	);
}

async function renderHistory() {
	const stored = await chrome.storage.local.get(SAVE_HISTORY_KEY);
	const history = Array.isArray(stored[SAVE_HISTORY_KEY])
		? stored[SAVE_HISTORY_KEY]
		: [];

	historyList.textContent = "";

	if (history.length === 0) {
		renderListMessage(historyList, t("historyEmpty"));
		return;
	}

	for (const item of history) {
		const rawPath = item.finalPath || item.requestedPath || "";
		const meta = [
			item.format ? item.format.toUpperCase() : "",
			item.action === "copy-path"
				? t("historyActionCopyPath")
				: t("historyActionSaveOnly"),
			item.partialCapture
				? t("historyStatusPartial")
				: item.status === "interrupted"
				? t("historyStatusInterrupted")
				: t("historyStatusCompleted"),
			getPartialCaptureMeta(item),
		]
			.filter(Boolean)
			.join(" · ");
		const extra = item.error ? `${meta} · ${item.error}` : meta;
		const itemStatus =
			item.status === "interrupted" || item.error
				? "error"
				: item.partialCapture
					? "warning"
					: "success";

		const listItem = document.createElement("li");
		listItem.className = "list-item";
		listItem.dataset.status = itemStatus;

		const headDiv = document.createElement("div");
		headDiv.className = "list-head";

		const titleDiv = document.createElement("div");
		titleDiv.className = "list-title";
		titleDiv.textContent = extractName(rawPath);

		const time = createTimeElement(item.finishedAt || item.createdAt);
		headDiv.append(titleDiv, time);

		const messageDiv = document.createElement("div");
		messageDiv.className = "list-message";
		messageDiv.textContent = rawPath || t("historyMissingFinalPath");

		const metaDiv = document.createElement("div");
		metaDiv.className = "list-meta";
		metaDiv.textContent = extra;

		listItem.append(headDiv, messageDiv, metaDiv);
		historyList.append(listItem);
	}
}

async function renderActivity() {
	const stored = await chrome.storage.local.get(RECENT_ACTIVITY_KEY);
	const activity = Array.isArray(stored[RECENT_ACTIVITY_KEY])
		? stored[RECENT_ACTIVITY_KEY]
		: [];

	activityList.textContent = "";

	if (activity.length === 0) {
		renderListMessage(activityList, t("activityEmpty"));
		return;
	}

	for (const item of activity) {
		const listItem = document.createElement("li");
		listItem.className = "list-item";
		listItem.dataset.status = ["error", "warning"].includes(item.status)
			? item.status
			: "success";

		const headDiv = document.createElement("div");
		headDiv.className = "list-head";

		const titleDiv = document.createElement("div");
		titleDiv.className = "list-title";
		titleDiv.textContent = item.title || t("errorUnknown");

		const time = createTimeElement(item.createdAt);
		headDiv.append(titleDiv, time);

		const messageDiv = document.createElement("div");
		messageDiv.className = "list-message";
		messageDiv.textContent = item.message || t("errorUnknown");

		listItem.append(headDiv, messageDiv);
		activityList.append(listItem);
	}
}

function getPartialCaptureMeta(item) {
	if (!item.partialCapture) {
		return "";
	}

	const reasonKey = {
		scroll_stalled: "partialReasonScrollStalled",
		tab_changed: "partialReasonTabChanged",
		capture_failed: "partialReasonCaptureFailed",
	}[item.partialReason];
	const capturedHeight = Number(item.capturedHeight);
	const totalHeight = Number(item.totalHeight);
	const details = reasonKey ? [t(reasonKey)] : [];
	if (
		Number.isSafeInteger(capturedHeight) &&
		capturedHeight > 0 &&
		Number.isSafeInteger(totalHeight) &&
		totalHeight >= capturedHeight
	) {
		details.push(
			t("historyPartialProgress", [
				String(capturedHeight),
				String(totalHeight),
			]),
		);
	}

	return details.join(" · ");
}

function renderListMessage(list, message, status = "") {
	list.textContent = "";
	const item = document.createElement("li");
	item.className = "empty";
	if (status) {
		item.dataset.status = status;
	}
	item.textContent = message;
	list.append(item);
}

function createTimeElement(value) {
	const time = document.createElement("time");
	time.className = "list-time";
	time.dateTime = value || "";
	time.textContent = formatTime(value);
	return time;
}

function formatTime(value) {
	if (!value) {
		return "";
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	return new Intl.DateTimeFormat(activeLocale.replace("_", "-"), {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
}

function extractName(path) {
	if (!path) {
		return t("historyUntitledFile");
	}

	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").pop() || normalized;
}

function localizeStaticContent() {
	document.documentElement.lang = normalizeHtmlLang(activeLocale);
	document.title = t("optionsTitle");
	heroEyebrow.textContent = t("heroEyebrow");
	optionsHeading.textContent = t("optionsHeading");
	optionsIntro.textContent = t("optionsIntro");
	heroTilePng.textContent = t("heroTilePng");
	heroTilePath.textContent = t("heroTilePath");
	heroTileLocal.textContent = t("heroTileLocal");
	heroNote.textContent = t("heroNote");
	sectionTagInterface.textContent = t("sectionTagInterface");
	sectionTagOutput.textContent = t("sectionTagOutput");
	sectionTagBehavior.textContent = t("sectionTagBehavior");
	sectionTagRecords.textContent = t("sectionTagRecords");
	panelLanguageTitle.textContent = t("panelLanguageTitle");
	panelLanguageBody.textContent = t("panelLanguageBody");
	localeOverrideLabel.textContent = t("labelLanguage");
	setLocaleOptionText("auto", t("languageOptionAuto"));
	setLocaleOptionText("en", t("languageOptionEnglish"));
	setLocaleOptionText("zh_CN", t("languageOptionZhCn"));
	setLocaleOptionText("zh_TW", t("languageOptionZhTw"));
	setLocaleOptionText("es", t("languageOptionSpanish"));
	setLocaleOptionText("de", t("languageOptionGerman"));
	panelQualityTitle.textContent = t("panelQualityTitle");
	panelQualityBody.textContent = t("panelQualityBody");
	panelSaveModeTitle.textContent = t("panelSaveModeTitle");
	panelSaveModeBody.textContent = t("panelSaveModeBody");
	silentSaveLabel.textContent = t("toggleSilentSave");
	panelHistoryTitle.textContent = t("panelHistoryTitle");
	panelHistoryBody.textContent = t("panelHistoryBody");
	activityTitle.textContent = t("panelActivityTitle");
	autoSaveHint.textContent = t("statusSettingsAutoSave");
	resetButton.textContent = t("buttonResetSettings");
	openHistoryButton.textContent = t("buttonOpenHistory");
	clearHistoryButton.textContent = t("buttonClearHistory");
	historyDialogTitle.textContent = t("dialogHistoryTitle");
	closeHistoryButton.textContent = t("buttonClose");
}

function updateQualityLabel(element, messageName, value) {
	const label = t(messageName);
	const formatted = Number(value).toFixed(2);
	const valueElement = element.querySelector(".value");
	if (valueElement) {
		valueElement.textContent = formatted;
	}

	element.childNodes[0].textContent = `${label} `;
}

function normalizeHtmlLang(value) {
	return String(value || "en").replace("_", "-");
}

function t(messageName, substitutions) {
	return translate(messageName, substitutions) || messageName;
}

async function setLocale(localeOverride) {
	const translator = await getTranslator(localeOverride);
	activeLocale = translator.locale;
	translate = translator.t;
	localizeStaticContent();
}

function setLocaleOptionText(value, label) {
	const option = localeOverrideSelect.querySelector(`option[value="${value}"]`);
	if (option) {
		option.textContent = label;
	}
}

function scheduleAutoSave() {
	window.clearTimeout(autoSaveTimeoutId);
	autoSaveTimeoutId = window.setTimeout(() => {
		void persistSettings({ refreshRecords: false });
	}, AUTO_SAVE_DELAY_MS);
}

function persistSettings(options) {
	const requestedSettings = {
		localeOverride: localeOverrideSelect.value,
		jpgQuality: jpgQualityInput.value,
		webpQuality: webpQualityInput.value,
		silentSave: silentSaveInput.checked,
	};
	return queueSettingsMutation(() =>
		persistSettingsNow({ ...options, requestedSettings }),
	);
}

async function persistSettingsNow({ refreshRecords, requestedSettings }) {
	window.clearTimeout(autoSaveTimeoutId);

	try {
		const saved = await saveSettings(requestedSettings);

		await setLocale(saved.localeOverride);
		applySettings(saved);
		setOperationStatus(t("statusSettingsSaved"), "success");
		showToast(t("statusSettingsSaved"));

		if (refreshRecords) {
			await Promise.all([refreshHistory(), refreshActivity()]);
		}
	} catch (error) {
		showOperationErrors([["statusSettingsSaveFailed", error]]);
	}
}

function restoreDefaults() {
	window.clearTimeout(autoSaveTimeoutId);
	resetButton.disabled = true;
	return queueSettingsMutation(restoreDefaultsNow);
}

async function restoreDefaultsNow() {
	try {
		const saved = await saveSettings(DEFAULT_SETTINGS);
		await setLocale(saved.localeOverride);
		applySettings(saved);
		setOperationStatus(t("statusDefaultsRestored"), "success");
		showToast(t("statusDefaultsRestored"));
		await Promise.all([refreshHistory(), refreshActivity()]);
	} catch (error) {
		showOperationErrors([["statusSettingsSaveFailed", error]]);
	} finally {
		resetButton.disabled = false;
	}
}

function queueSettingsMutation(operation) {
	const current = settingsMutationQueue.catch(() => {}).then(operation);
	settingsMutationQueue = current;
	return current;
}

async function clearHistory() {
	if (!window.confirm(t("confirmClearHistory"))) {
		return;
	}

	clearHistoryButton.disabled = true;

	try {
		const response = await chrome.runtime.sendMessage({
			type: "CLEAR_SAVE_HISTORY",
		});
		if (!response?.ok) {
			throw new Error(response?.error || t("statusHistoryClearFailed"));
		}

		await renderHistory();
		setOperationStatus(t("statusHistoryCleared"), "success");
		showToast(t("statusHistoryCleared"));
	} catch (error) {
		showOperationErrors([["statusHistoryClearFailed", error]]);
	} finally {
		clearHistoryButton.disabled = false;
	}
}

async function refreshHistory() {
	try {
		await renderHistory();
	} catch (error) {
		const message = formatOperationError("statusHistoryLoadFailed", error);
		renderListMessage(historyList, message, "error");
		setOperationStatus(message, "error");
	}
}

async function refreshActivity() {
	try {
		await renderActivity();
	} catch (error) {
		const message = formatOperationError("statusHistoryLoadFailed", error);
		renderListMessage(activityList, message, "error");
		setOperationStatus(message, "error");
	}
}

function showOperationErrors(failures) {
	const message = failures
		.map(([messageName, error]) => formatOperationError(messageName, error))
		.join(" ");
	setOperationStatus(message, "error");
}

function formatOperationError(messageName, error) {
	const detail = getErrorMessage(error);
	return detail ? `${t(messageName)} ${detail}` : t(messageName);
}

function getErrorMessage(error) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	return "";
}

function setOperationStatus(message, kind) {
	operationStatus.dataset.kind = kind;
	operationStatus.setAttribute("role", kind === "error" ? "alert" : "status");
	operationStatus.setAttribute(
		"aria-live",
		kind === "error" ? "assertive" : "polite",
	);
	operationStatus.hidden = !message;
	operationStatus.textContent = message;
}

function showToast(message) {
	toast.textContent = message;
	toast.dataset.visible = "true";
	window.clearTimeout(toastTimeoutId);
	toastTimeoutId = window.setTimeout(() => {
		toast.dataset.visible = "false";
	}, 1600);
}
