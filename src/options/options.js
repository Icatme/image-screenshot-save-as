import { getTranslator } from "../lib/i18n.js";
import {
	DEFAULT_SETTINGS,
	getSettings,
	saveSettings,
} from "../lib/settings.js";

const SAVE_HISTORY_KEY = "saveHistory";
const RECENT_ACTIVITY_KEY = "recentActivity";
const AUTO_SAVE_DELAY_MS = 240;
const RECORDS_PAGE_SIZE = 5;

let activeLocale = "en";
let translate = (messageName) => messageName;
let autoSaveTimeoutId = null;
let toastTimeoutId = null;
let settingsMutationQueue = Promise.resolve();
let activeSettingsMutations = 0;
let settingsRevision = 0;
let historyRenderRevision = 0;
let activityRenderRevision = 0;
let activeRecordsTab = "history";
let historyEntries = [];
let activityEntries = [];
let historyPage = 1;
let activityPage = 1;

const form = document.getElementById("settings-form");
const productName = document.getElementById("product-name");
const optionsKicker = document.getElementById("options-kicker");
const settingsHeading = document.getElementById("settings-heading");
const runtimeGrid = document.getElementById("runtime-grid");
const runtimeVersionLabel = document.getElementById("runtime-version-label");
const runtimeVersionValue = document.getElementById("runtime-version-value");
const runtimeChromeLabel = document.getElementById("runtime-chrome-label");
const runtimeChromeValue = document.getElementById("runtime-chrome-value");
const runtimeArchitectureLabel = document.getElementById(
	"runtime-architecture-label",
);
const runtimeArchitectureValue = document.getElementById(
	"runtime-architecture-value",
);
const panelLanguageTitle = document.getElementById("panel-language-title");
const panelLanguageBody = document.getElementById("panel-language-body");
const localeOverrideLabel = document.getElementById("locale-override-label");
const localeOverrideSelect = document.getElementById("locale-override");
const panelScreenshotTitle = document.getElementById("panel-screenshot-title");
const panelScreenshotBody = document.getElementById("panel-screenshot-body");
const defaultScreenshotFormatLabel = document.getElementById(
	"default-screenshot-format-label",
);
const defaultScreenshotFormatSelect = document.getElementById(
	"default-screenshot-format",
);
const jpgQualityInput = document.getElementById("jpg-quality");
const webpQualityInput = document.getElementById("webp-quality");
const copyPathAfterSaveInput = document.getElementById("copy-path-after-save");
const copyPathAfterSaveLabel = document.getElementById(
	"copy-path-after-save-label",
);
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
const recordsTablist = document.getElementById("records-tablist");
const historyTabButton = document.getElementById("tab-history");
const historyTabLabel = document.getElementById("tab-history-label");
const historyTabCount = document.getElementById("tab-history-count");
const activityTabButton = document.getElementById("tab-activity");
const activityTabLabel = document.getElementById("tab-activity-label");
const activityTabCount = document.getElementById("tab-activity-count");
const historyPanel = document.getElementById("history-panel");
const activityPanel = document.getElementById("activity-panel");
const historyScroll = document.getElementById("history-scroll");
const activityScroll = document.getElementById("activity-scroll");
const historyList = document.getElementById("history-list");
const activityList = document.getElementById("activity-list");
const historyPagination = document.getElementById("history-pagination");
const historyPrevButton = document.getElementById("history-prev-button");
const historyPageInfo = document.getElementById("history-page-info");
const historyNextButton = document.getElementById("history-next-button");
const activityPagination = document.getElementById("activity-pagination");
const activityPrevButton = document.getElementById("activity-prev-button");
const activityPageInfo = document.getElementById("activity-page-info");
const activityNextButton = document.getElementById("activity-next-button");
const autoSaveHint = document.getElementById("auto-save-hint");
const operationStatus = document.getElementById("operation-status");
const toast = document.getElementById("toast");

void initialize();

async function initialize() {
	setActiveRecordsTab(activeRecordsTab);
	bindEventListeners();
	form.setAttribute("aria-busy", "true");
	renderRuntimeInfo();

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

	if (settingsRevision === 0) {
		applySettings(settings);
	}

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

	defaultScreenshotFormatSelect.addEventListener("change", () => {
		void persistSettings({ refreshRecords: false });
	});

	copyPathAfterSaveInput.addEventListener("change", () => {
		void persistSettings({ refreshRecords: false });
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
		historyPage = 1;
		activityPage = 1;
		await Promise.all([refreshHistory(), refreshActivity()]);
		historyScroll.scrollTop = 0;
		activityScroll.scrollTop = 0;
		if (!historyDialog.open) {
			historyDialog.showModal();
		}
	});

	closeHistoryButton.addEventListener("click", () => {
		historyDialog.close();
	});

	historyDialog.addEventListener("click", (event) => {
		if (event.target === historyDialog) {
			historyDialog.close();
		}
	});

	historyTabButton.addEventListener("click", () => {
		setActiveRecordsTab("history");
	});

	activityTabButton.addEventListener("click", () => {
		setActiveRecordsTab("activity");
	});

	historyTabButton.addEventListener("keydown", (event) => {
		handleRecordsTabKeydown(event);
	});

	activityTabButton.addEventListener("keydown", (event) => {
		handleRecordsTabKeydown(event);
	});

	historyPrevButton.addEventListener("click", () => {
		setHistoryPage(historyPage - 1);
	});

	historyNextButton.addEventListener("click", () => {
		setHistoryPage(historyPage + 1);
	});

	activityPrevButton.addEventListener("click", () => {
		setActivityPage(activityPage - 1);
	});

	activityNextButton.addEventListener("click", () => {
		setActivityPage(activityPage + 1);
	});

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName === "sync") {
			void syncExternalSettings(changes);
			return;
		}

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

async function syncExternalSettings(changes) {
	if (autoSaveTimeoutId !== null || activeSettingsMutations > 0) {
		return;
	}
	const revision = settingsRevision;
	try {
		const latest = await getSettings();
		if (
			revision !== settingsRevision ||
			autoSaveTimeoutId !== null ||
			activeSettingsMutations > 0
		) {
			return;
		}
		if (changes.localeOverride) {
			await setLocale(latest.localeOverride, revision);
			if (
				revision !== settingsRevision ||
				autoSaveTimeoutId !== null ||
				activeSettingsMutations > 0
			) {
				return;
			}
			applySettings(latest);
			await Promise.all([refreshHistory(), refreshActivity()]);
			return;
		}
		applySettings(latest);
	} catch (error) {
		showOperationErrors([["statusSettingsLoadFailed", error]]);
	}
}

function applySettings(settings) {
	localeOverrideSelect.value = settings.localeOverride;
	defaultScreenshotFormatSelect.value = settings.defaultScreenshotFormat;
	jpgQualityInput.value = String(settings.jpgQuality);
	webpQualityInput.value = String(settings.webpQuality);
	copyPathAfterSaveInput.checked = settings.copyPathAfterSave;
	silentSaveInput.checked = settings.silentSave;
	updateQualityLabel(jpgQualityLabel, "labelJpgQuality", settings.jpgQuality);
	updateQualityLabel(
		webpQualityLabel,
		"labelWebpQuality",
		settings.webpQuality,
	);
}

function renderRuntimeInfo() {
	const manifest = chrome.runtime.getManifest();
	runtimeVersionValue.textContent = manifest.version || "—";
	runtimeChromeValue.textContent = manifest.minimum_chrome_version
		? `Chrome ${manifest.minimum_chrome_version}+`
		: "Chrome";
	runtimeArchitectureValue.textContent = `Manifest V${manifest.manifest_version}`;
}

async function renderHistory() {
	const revision = ++historyRenderRevision;
	const stored = await chrome.storage.local.get(SAVE_HISTORY_KEY);
	if (revision !== historyRenderRevision) {
		return;
	}
	historyEntries = Array.isArray(stored[SAVE_HISTORY_KEY])
		? stored[SAVE_HISTORY_KEY]
		: [];
	historyTabCount.textContent = String(historyEntries.length);
	renderHistoryPage();
}

function renderHistoryPage() {
	const { page, totalPages, totalItems, pageItems } = paginateItems(
		historyEntries,
		historyPage,
	);
	historyPage = page;
	updatePaginationControls({
		container: historyPagination,
		prevButton: historyPrevButton,
		nextButton: historyNextButton,
		infoElement: historyPageInfo,
		page,
		totalPages,
		totalItems,
	});

	historyList.textContent = "";

	if (pageItems.length === 0) {
		renderListMessage(historyList, t("historyEmpty"));
		return;
	}

	for (const item of pageItems) {
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
	const revision = ++activityRenderRevision;
	const stored = await chrome.storage.local.get(RECENT_ACTIVITY_KEY);
	if (revision !== activityRenderRevision) {
		return;
	}
	activityEntries = Array.isArray(stored[RECENT_ACTIVITY_KEY])
		? stored[RECENT_ACTIVITY_KEY]
		: [];
	activityTabCount.textContent = String(activityEntries.length);
	renderActivityPage();
}

function renderActivityPage() {
	const { page, totalPages, totalItems, pageItems } = paginateItems(
		activityEntries,
		activityPage,
	);
	activityPage = page;
	updatePaginationControls({
		container: activityPagination,
		prevButton: activityPrevButton,
		nextButton: activityNextButton,
		infoElement: activityPageInfo,
		page,
		totalPages,
		totalItems,
	});

	activityList.textContent = "";

	if (pageItems.length === 0) {
		renderListMessage(activityList, t("activityEmpty"));
		return;
	}

	for (const item of pageItems) {
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

function setActiveRecordsTab(tabName, { focus = false } = {}) {
	activeRecordsTab = tabName === "activity" ? "activity" : "history";
	const isHistory = activeRecordsTab === "history";
	historyTabButton.setAttribute("aria-selected", String(isHistory));
	historyTabButton.tabIndex = isHistory ? 0 : -1;
	activityTabButton.setAttribute("aria-selected", String(!isHistory));
	activityTabButton.tabIndex = isHistory ? -1 : 0;
	historyPanel.hidden = !isHistory;
	activityPanel.hidden = isHistory;
	if (focus) {
		(isHistory ? historyTabButton : activityTabButton).focus?.();
	}
}

function handleRecordsTabKeydown(event) {
	if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
		event.preventDefault();
		setActiveRecordsTab(
			activeRecordsTab === "history" ? "activity" : "history",
			{ focus: true },
		);
		return;
	}

	if (event.key === "Home") {
		event.preventDefault();
		setActiveRecordsTab("history", { focus: true });
		return;
	}

	if (event.key === "End") {
		event.preventDefault();
		setActiveRecordsTab("activity", { focus: true });
	}
}

function setHistoryPage(nextPage) {
	historyPage = nextPage;
	renderHistoryPage();
	historyScroll.scrollTop = 0;
}

function setActivityPage(nextPage) {
	activityPage = nextPage;
	renderActivityPage();
	activityScroll.scrollTop = 0;
}

function paginateItems(items, requestedPage) {
	const totalItems = items.length;
	const totalPages = Math.max(1, Math.ceil(totalItems / RECORDS_PAGE_SIZE));
	const page = Math.min(Math.max(1, requestedPage), totalPages);
	const startIndex = (page - 1) * RECORDS_PAGE_SIZE;
	return {
		page,
		totalPages,
		totalItems,
		pageItems: items.slice(startIndex, startIndex + RECORDS_PAGE_SIZE),
	};
}

function updatePaginationControls({
	container,
	prevButton,
	nextButton,
	infoElement,
	page,
	totalPages,
	totalItems,
}) {
	const showPagination = totalPages > 1;
	container.hidden = !showPagination;
	prevButton.disabled = page <= 1;
	nextButton.disabled = page >= totalPages;
	infoElement.textContent = showPagination
		? t("historyPaginationStatus", [
				String(page),
				String(totalPages),
				String(totalItems),
			])
		: "";
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
	productName.textContent = t("extName");
	optionsKicker.textContent = t("optionsKicker");
	optionsHeading.textContent = t("optionsHeading");
	optionsIntro.textContent = t("optionsIntro");
	settingsHeading.textContent = t("optionsSettingsHeading");
	runtimeGrid.setAttribute("aria-label", t("runtimeInfoLabel"));
	runtimeVersionLabel.textContent = t("runtimeVersionLabel");
	runtimeChromeLabel.textContent = t("runtimeChromeLabel");
	runtimeArchitectureLabel.textContent = t("runtimeArchitectureLabel");
	panelLanguageTitle.textContent = t("panelLanguageTitle");
	panelLanguageBody.textContent = t("panelLanguageBody");
	localeOverrideLabel.textContent = t("labelLanguage");
	setLocaleOptionText("auto", t("languageOptionAuto"));
	setLocaleOptionText("en", t("languageOptionEnglish"));
	setLocaleOptionText("zh_CN", t("languageOptionZhCn"));
	setLocaleOptionText("zh_TW", t("languageOptionZhTw"));
	setLocaleOptionText("es", t("languageOptionSpanish"));
	setLocaleOptionText("de", t("languageOptionGerman"));
	panelScreenshotTitle.textContent = t("panelScreenshotTitle");
	panelScreenshotBody.textContent = t("panelScreenshotBody");
	defaultScreenshotFormatLabel.textContent = t("labelDefaultScreenshotFormat");
	panelQualityTitle.textContent = t("panelQualityTitle");
	panelQualityBody.textContent = t("panelQualityBody");
	panelSaveModeTitle.textContent = t("panelSaveModeTitle");
	panelSaveModeBody.textContent = t("panelSaveModeBody");
	copyPathAfterSaveLabel.textContent = t("toggleCopyPathAfterSave");
	silentSaveLabel.textContent = t("toggleSilentSave");
	panelHistoryTitle.textContent = t("panelHistoryTitle");
	panelHistoryBody.textContent = t("panelHistoryBody");
	recordsTablist.setAttribute("aria-label", t("historyTabsLabel"));
	historyTabLabel.textContent = t("dialogHistoryTitle");
	activityTabLabel.textContent = t("panelActivityTitle");
	historyPagination.setAttribute("aria-label", t("historyPaginationLabel"));
	activityPagination.setAttribute("aria-label", t("historyPaginationLabel"));
	historyPrevButton.textContent = t("buttonPreviousPage");
	historyNextButton.textContent = t("buttonNextPage");
	activityPrevButton.textContent = t("buttonPreviousPage");
	activityNextButton.textContent = t("buttonNextPage");
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

async function setLocale(localeOverride, revision = settingsRevision) {
	const translator = await getTranslator(localeOverride);
	if (revision !== settingsRevision) return;
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
	const revision = ++settingsRevision;
	const requestedSettings = readSettingsForm();
	autoSaveTimeoutId = window.setTimeout(() => {
		autoSaveTimeoutId = null;
		void queueSettingsMutation(() => persistSettingsNow({
			refreshRecords: false, requestedSettings, revision,
		}));
	}, AUTO_SAVE_DELAY_MS);
}

function readSettingsForm() {
	return {
		localeOverride: localeOverrideSelect.value,
		defaultScreenshotFormat: defaultScreenshotFormatSelect.value,
		jpgQuality: jpgQualityInput.value,
		webpQuality: webpQualityInput.value,
		copyPathAfterSave: copyPathAfterSaveInput.checked,
		silentSave: silentSaveInput.checked,
	};
}

function persistSettings(options) {
	window.clearTimeout(autoSaveTimeoutId);
	autoSaveTimeoutId = null;
	const revision = ++settingsRevision;
	const requestedSettings = readSettingsForm();
	return queueSettingsMutation(() =>
		persistSettingsNow({ ...options, requestedSettings, revision }),
	);
}

async function persistSettingsNow({ refreshRecords, requestedSettings, revision }) {
	activeSettingsMutations += 1;
	try {
		const saved = await saveSettings(requestedSettings);
		if (revision !== settingsRevision) return;
		await setLocale(saved.localeOverride, revision);
		if (revision !== settingsRevision) return;
		applySettings(saved);
		setOperationStatus(t("statusSettingsSaved"), "success");
		showToast(t("statusSettingsSaved"));

		if (refreshRecords) {
			await Promise.all([refreshHistory(), refreshActivity()]);
		}
	} catch (error) {
		showOperationErrors([["statusSettingsSaveFailed", error]]);
	} finally {
		activeSettingsMutations -= 1;
	}
}

function restoreDefaults() {
	window.clearTimeout(autoSaveTimeoutId);
	autoSaveTimeoutId = null;
	const revision = ++settingsRevision;
	applySettings(DEFAULT_SETTINGS);
	resetButton.disabled = true;
	return queueSettingsMutation(() => restoreDefaultsNow(revision));
}

async function restoreDefaultsNow(revision) {
	activeSettingsMutations += 1;
	try {
		const saved = await saveSettings(DEFAULT_SETTINGS);
		if (revision !== settingsRevision) return;
		await setLocale(saved.localeOverride, revision);
		if (revision !== settingsRevision) return;
		applySettings(saved);
		setOperationStatus(t("statusDefaultsRestored"), "success");
		showToast(t("statusDefaultsRestored"));
		await Promise.all([refreshHistory(), refreshActivity()]);
	} catch (error) {
		showOperationErrors([["statusSettingsSaveFailed", error]]);
	} finally {
		activeSettingsMutations -= 1;
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

		historyPage = 1;
		activityPage = 1;
		await Promise.all([renderHistory(), renderActivity()]);
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
		historyEntries = [];
		historyPage = 1;
		historyTabCount.textContent = "0";
		historyPagination.hidden = true;
		renderListMessage(historyList, message, "error");
		setOperationStatus(message, "error");
	}
}

async function refreshActivity() {
	try {
		await renderActivity();
	} catch (error) {
		const message = formatOperationError("statusHistoryLoadFailed", error);
		activityEntries = [];
		activityPage = 1;
		activityTabCount.textContent = "0";
		activityPagination.hidden = true;
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
