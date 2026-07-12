import { getTranslator } from "../lib/i18n.js";
import {
	DEFAULT_SETTINGS,
	getSettings,
	saveSettings,
} from "../lib/settings.js";

const SAVE_HISTORY_KEY = "saveHistory";
const AUTO_SAVE_DELAY_MS = 240;
let activeLocale = "en";
let translate = (messageName) => messageName;
let autoSaveTimeoutId = null;
let toastTimeoutId = null;

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
const toast = document.getElementById("toast");
const historyList = document.getElementById("history-list");

void initialize();

async function initialize() {
	const settings = await getSettings();
	await setLocale(settings.localeOverride);
	applySettings(settings);
	await renderHistory();

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
		void persistSettings({ immediate: true });
	});

	silentSaveInput.addEventListener("change", () => {
		void persistSettings({ immediate: true });
	});

	resetButton.addEventListener("click", async () => {
		window.clearTimeout(autoSaveTimeoutId);
		const saved = await saveSettings(DEFAULT_SETTINGS);
		await setLocale(saved.localeOverride);
		applySettings(saved);
		await renderHistory();
		showToast(t("statusDefaultsRestored"));
	});

	clearHistoryButton.addEventListener("click", async () => {
		await chrome.storage.local.remove(SAVE_HISTORY_KEY);
		await renderHistory();
		showToast(t("statusHistoryCleared"));
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
		const emptyDiv = document.createElement("div");
		emptyDiv.className = "empty";
		emptyDiv.textContent = t("historyEmpty");
		historyList.append(emptyDiv);
		return;
	}

	for (const item of history) {
		const rawPath = item.finalPath || item.requestedPath || "";
		const meta = [
			item.format ? item.format.toUpperCase() : "",
			item.action === "copy-path"
				? t("historyActionCopyPath")
				: t("historyActionSaveOnly"),
			item.status === "interrupted"
				? t("historyStatusInterrupted")
				: t("historyStatusCompleted"),
		]
			.filter(Boolean)
			.join(" · ");
		const extra = item.error ? `${meta} · ${item.error}` : meta;
		const itemStatus =
			item.status === "interrupted" || item.error ? "error" : "success";

		const article = document.createElement("article");
		article.className = "list-item";
		article.dataset.status = itemStatus;

		const headDiv = document.createElement("div");
		headDiv.className = "list-head";

		const titleDiv = document.createElement("div");
		titleDiv.className = "list-title";
		titleDiv.textContent = extractName(rawPath);

		const timeDiv = document.createElement("div");
		timeDiv.className = "list-time";
		timeDiv.textContent = formatTime(item.finishedAt || item.createdAt);

		headDiv.append(titleDiv, timeDiv);

		const messageDiv = document.createElement("div");
		messageDiv.className = "list-message";
		messageDiv.textContent = rawPath || t("historyMissingFinalPath");

		const metaDiv = document.createElement("div");
		metaDiv.className = "list-meta";
		metaDiv.textContent = extra;

		article.append(headDiv, messageDiv, metaDiv);
		historyList.append(article);
	}
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
		void persistSettings({ immediate: false });
	}, AUTO_SAVE_DELAY_MS);
}

async function persistSettings({ immediate }) {
	window.clearTimeout(autoSaveTimeoutId);

	const saved = await saveSettings({
		localeOverride: localeOverrideSelect.value,
		jpgQuality: jpgQualityInput.value,
		webpQuality: webpQualityInput.value,
		silentSave: silentSaveInput.checked,
	});

	await setLocale(saved.localeOverride);
	applySettings(saved);
	showToast(t("statusSettingsSaved"));

	if (immediate) {
		await renderHistory();
	}
}

function showToast(message) {
	toast.textContent = message;
	toast.dataset.visible = "true";
	window.clearTimeout(toastTimeoutId);
	toastTimeoutId = window.setTimeout(() => {
		toast.dataset.visible = "false";
	}, 1600);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
