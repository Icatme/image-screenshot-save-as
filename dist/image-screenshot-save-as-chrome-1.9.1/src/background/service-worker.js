import {
	closeOffscreenDocumentIfIdle,
	copyTextToClipboard,
	createBlobUrl,
	revokeBlobUrl,
} from "../lib/clipboard.js";
import {
	buildDownloadPath,
	buildScreenshotDownloadPath,
} from "../lib/file-name.js";
import { createScreenshotDirectorySink, loadScreenshotDirectory } from "../lib/screenshot-directory.js";
import { getTranslator } from "../lib/i18n.js";
import { convertImageBlob } from "../lib/image-convert.js";
import {
	IMAGE_ERROR_CODES,
	getCanvasContextOptions,
	getImageEncodeOptions,
	prepareCanvasForEncoding,
} from "../lib/image-encoding.js";
import {
	ensureFileSchemeAccess,
	getSourceImageBlob,
	readDataUrlBlob,
} from "../lib/image-source.js";
import { isExtensionGalleryUrl } from "../lib/page-access.js";
import { getSettings } from "../lib/settings.js";
import {
	captureScreenshotFrames,
	ScreenshotPaginationRequired,
} from "../lib/screenshot-capture.js";
import {
	canCaptureSingleImage,
	MAX_SCREENSHOT_EDGE,
	MAX_SCREENSHOT_PIXELS,
} from "../lib/screenshot-pagination.js";
import {
	isPagePreparedForScreenshot,
	preparePageForScreenshot,
	restorePageAfterScreenshot,
	scrollPageForScreenshot,
} from "../lib/screenshot-page.js";
import {
	getScreenshotRegionPixels,
	selectScreenshotRegion,
} from "../lib/screenshot-region.js";
import {
	acquireScreenshotLease,
	releaseScreenshotLease,
	takeStaleScreenshotLease,
	updateScreenshotLease,
	waitForScreenshotCaptureSlot,
} from "../lib/capture-state.js";
import {
	appendActivity as storeActivity,
	appendSaveHistory as storeSaveHistory,
	clearSaveHistory,
	deletePendingDownload,
	getPendingDownload,
	listPendingDownloads,
	sanitizeSaveHistory,
	setPendingDownload,
} from "../lib/storage-state.js";

const ROOT_MENU_ID = "img-save-as";
const SCREENSHOT_MENU_ID = "page-screenshot-as";
const PAGINATION_REQUEST_KEY = "screenshotPaginationRequest";
const PAGINATION_PAGE = "src/pagination/pagination.html";
// Throttle between captureVisibleTab calls to avoid overwhelming the API and allow
// the page to settle after scrolling (Chrome's capture is not instantaneous).
const CAPTURE_INTERVAL_MS = 550;
const SCREENSHOT_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;
const SCREENSHOT_SELECTION_TIMEOUT_MS = 2 * 60 * 1000;
const PARTIAL_CAPTURE_REASONS = Object.freeze({
	SCROLL_STALLED: "scroll_stalled",
	TAB_CHANGED: "tab_changed",
	CAPTURE_FAILED: "capture_failed",
});
const WORKER_INSTANCE_ID = crypto.randomUUID();
const downloadProcessingQueues = new Map();
let activeLocaleOverride = null;
let translate = (messageName, substitutions) => {
	return chrome.i18n?.getMessage(messageName, substitutions) || messageName;
};
let captureCallQueue = Promise.resolve();
let contextMenuUpdateQueue = Promise.resolve();
let badgeResetTimeoutId = null;
let runtimeReadyPromise = null;

class RecoverableScreenshotError extends Error {
	constructor(reason, message) {
		super(message);
		this.name = "RecoverableScreenshotError";
		this.partialReason = reason;
	}
}

const FORMATS = [
	{ id: "png", title: "PNG" },
	{ id: "jpg", title: "JPG" },
	{ id: "webp", title: "WebP" },
];

const ACTIONS = [
	{ id: "save", titleKey: "menuActionSave" },
	{ id: "copy-path", titleKey: "menuActionCopyPath" },
];

const SCREENSHOT_MODES = [
	{ id: "visible", titleKey: "menuScreenshotVisible" },
	{ id: "region", titleKey: "menuScreenshotRegion" },
	{ id: "full-page", titleKey: "menuScreenshotFullPage" },
];

chrome.runtime.onInstalled.addListener(() => {
	void initializeExtension().catch(reportBackgroundError);
});

chrome.runtime.onStartup.addListener(() => {
	void initializeStartup().catch(reportBackgroundError);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	void handleMenuClick(info, tab).catch(reportBackgroundError);
});

chrome.downloads.onChanged.addListener((downloadDelta) => {
	void handleDownloadChanged(downloadDelta).catch(reportBackgroundError);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName === "sync" && changes.localeOverride) {
		void ensureRuntimeReady()
			.then(createContextMenus)
			.catch(reportBackgroundError);
	}
});

chrome.action.onClicked.addListener(() => {
	void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "GET_PAGED_SCREENSHOT_STATUS") {
		void getPagedScreenshotStatus(message, _sender)
			.then((request) => sendResponse({ ok: true, request }))
			.catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
		return true;
	}
	if (message?.type === "SAVE_PAGED_SCREENSHOT") {
		void savePagedScreenshot(message, _sender)
			.then((result) => sendResponse({ ok: true, ...result }))
			.catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
		return true;
	}

	if (message?.type === "CAN_REAP_BLOB_URL") {
		void canReapBlobUrl(message.url)
			.then((reap) => sendResponse({ ok: true, reap }))
			.catch((error) => {
				sendResponse({ ok: false, error: getErrorMessage(error) });
			});
		return true;
	}

	if (message?.type === "BLOB_URL_REAPED") {
		void acknowledgeReapedBlobUrl(message.url)
			.then(() => sendResponse({ ok: true }))
			.catch((error) => {
				sendResponse({ ok: false, error: getErrorMessage(error) });
			});
		return true;
	}

	if (message?.type === "CLEAR_SAVE_HISTORY") {
		void clearSaveHistory()
			.then(() => sendResponse({ ok: true }))
			.catch((error) => {
				sendResponse({ ok: false, error: getErrorMessage(error) });
			});
		return true;
	}

	return false;
});

void ensureRuntimeReady().catch(reportBackgroundError);

async function initializeExtension() {
	await sanitizeSaveHistory();
	await ensureRuntimeReady();
	await createContextMenus();
}

async function initializeStartup() {
	await ensureRuntimeReady();
	await createContextMenus();
}

function ensureRuntimeReady() {
	if (!runtimeReadyPromise) {
		runtimeReadyPromise = initializeRuntime().catch((error) => {
			runtimeReadyPromise = null;
			throw error;
		});
	}

	return runtimeReadyPromise;
}

async function initializeRuntime() {
	await setTrustedStorageAccess();
	await refreshTranslations();
	await recoverStaleScreenshotLease();
	await recoverInterruptedPagination();
	await recoverPendingDownloads().catch((error) => {
		console.error("Failed to recover pending downloads.", error);
	});
}

function createContextMenus() {
	const operation = contextMenuUpdateQueue
		.catch(() => {})
		.then(rebuildContextMenus);
	contextMenuUpdateQueue = operation;
	return operation;
}

async function rebuildContextMenus() {
	await refreshTranslations();
	await chrome.contextMenus.removeAll();

	chrome.contextMenus.create({
		id: ROOT_MENU_ID,
		title: t("menuRoot"),
		contexts: ["image"],
	});

	for (const format of FORMATS) {
		const formatMenuId = `format:${format.id}`;
		chrome.contextMenus.create({
			id: formatMenuId,
			parentId: ROOT_MENU_ID,
			title: format.title,
			contexts: ["image"],
		});

		for (const action of ACTIONS) {
			chrome.contextMenus.create({
				id: buildActionMenuId(format.id, action.id),
				parentId: formatMenuId,
				title: t(action.titleKey),
				contexts: ["image"],
			});
		}
	}

	chrome.contextMenus.create({
		id: SCREENSHOT_MENU_ID,
		title: t("menuScreenshotRoot"),
		contexts: ["page"],
	});

	for (const mode of SCREENSHOT_MODES) {
		const modeMenuId = `screenshot-mode:${mode.id}`;
		chrome.contextMenus.create({
			id: modeMenuId,
			parentId: SCREENSHOT_MENU_ID,
			title: t(mode.titleKey),
			contexts: ["page"],
		});

		for (const format of FORMATS) {
			const formatMenuId = `screenshot-format:${mode.id}:${format.id}`;
			chrome.contextMenus.create({
				id: formatMenuId,
				parentId: modeMenuId,
				title: format.title,
				contexts: ["page"],
			});

			for (const action of ACTIONS) {
				chrome.contextMenus.create({
					id: buildScreenshotActionMenuId(mode.id, format.id, action.id),
					parentId: formatMenuId,
					title: t(action.titleKey),
					contexts: ["page"],
				});
			}
		}
	}
}

async function handleMenuClick(info, tab) {
	await ensureRuntimeReady();
	await refreshTranslations();
	const command = parseMenuId(info.menuItemId);
	if (!command) {
		return;
	}

	if (command.kind === "screenshot") {
		await handleScreenshotMenuClick(command, info, tab);
		return;
	}

	await handleImageMenuClick(command, info, tab);
}

async function handleImageMenuClick(command, info, tab) {
	if (!info.srcUrl) {
		await notify(
			t("notifySaveFailedTitle"),
			t("notifySaveFailedNoImageUrl"),
			"error",
		);
		return;
	}
	const pageUrl = info.pageUrl || tab?.url;

	try {
		const settings = await getSettings();
		await refreshTranslations(settings);
		const sourceBlob = await getSourceImageBlob(
			info.srcUrl,
			tab?.id,
			info.frameId,
			pageUrl,
			t,
		);
		const converted = await convertImageBlob(
			sourceBlob,
			command.format,
			settings,
		);
		const downloadPath = buildDownloadPath({
			srcUrl: info.srcUrl,
			pageTitle: tab?.title ?? "",
			format: command.format,
		});
		const downloadResult = await downloadBlob(
			converted.blob,
			downloadPath,
			settings.silentSave,
		);
		const downloadId = downloadResult.downloadId;

		await queuePendingDownload(downloadId, {
			historyId: crypto.randomUUID(),
			action: command.action,
			format: command.format,
			requestedPath: downloadPath,
			objectUrl: downloadResult.objectUrl,
			createdAt: new Date().toISOString(),
		});

		await processPendingDownload(downloadId);
	} catch (error) {
		await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
	}
}

async function handleScreenshotMenuClick(command, info, tab) {
	if (tab?.id == null || tab?.windowId == null) {
		await notify(
			t("notifySaveFailedTitle"),
			t("errorScreenshotNoTab"),
			"error",
		);
		return;
	}
	const pageUrl = info.pageUrl || tab.url;

	try {
		await ensureFileSchemeAccess(pageUrl, t);
	} catch (error) {
		await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
		return;
	}
	const requiresPageScript =
		command.mode === "region" || command.mode === "full-page";
	if (requiresPageScript && isExtensionGalleryUrl(pageUrl)) {
		await notify(
			t("notifySaveFailedTitle"),
			t("errorScreenshotScriptRestricted"),
			"error",
		);
		return;
	}

	const lease = {
		workerId: WORKER_INSTANCE_ID,
		tabId: tab.id,
		windowId: tab.windowId,
		tabUrl: pageUrl || "",
		startedAt: new Date().toISOString(),
		pageState: null,
	};
	const leaseResult = await acquireScreenshotLease(lease);
	if (!leaseResult.acquired) {
		await notify(
			t("notifySaveFailedTitle"),
			t("errorScreenshotAlreadyRunning"),
			"error",
		);
		return;
	}

	if (leaseResult.previousLease) {
		await restoreScreenshotLease(leaseResult.previousLease);
	}

	try {
		const settings = await getSettings();
		await refreshTranslations(settings);
		let sourceBlob;
		let partialCapture = false;
		let partialReason = "";
		let capturedHeight = 0;
		let totalHeight = 0;
		if (command.mode === "full-page") {
			const captureResult = await captureFullPageScreenshotBlob(
				tab,
				command.format,
				settings,
			);
			sourceBlob = captureResult.blob;
			partialCapture = captureResult.partial;
			partialReason = captureResult.partialReason;
			capturedHeight = captureResult.capturedHeight;
			totalHeight = captureResult.totalHeight;
		} else if (command.mode === "region") {
			sourceBlob = await captureRegionScreenshotBlob(
				tab,
				command.format,
				settings,
			);
		} else {
			sourceBlob = await captureVisibleScreenshotBlob(
				tab,
				command.format,
				settings,
			);
		}

		if (!sourceBlob) {
			return;
		}
		const downloadPath = buildScreenshotDownloadPath({
			pageTitle: tab.title ?? "",
			pageUrl: pageUrl ?? "",
			mode: command.mode,
			format: command.format,
			partial: partialCapture,
		});
		const downloadResult = await downloadBlob(
			sourceBlob,
			downloadPath,
			settings.silentSave,
		);
		const downloadId = downloadResult.downloadId;

		await queuePendingDownload(downloadId, {
			historyId: crypto.randomUUID(),
			action: command.action,
			captureType: "screenshot",
			screenshotMode: command.mode,
			partialCapture,
			partialReason,
			capturedHeight,
			totalHeight,
			format: command.format,
			requestedPath: downloadPath,
			objectUrl: downloadResult.objectUrl,
			createdAt: new Date().toISOString(),
		});

		await processPendingDownload(downloadId);
	} catch (error) {
		if (error instanceof ScreenshotPaginationRequired) {
			await openScreenshotPagination(tab, command, error);
		} else {
			await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
		}
	} finally {
		await releaseScreenshotLease(WORKER_INSTANCE_ID);
	}
}

async function handleDownloadChanged(downloadDelta) {
	if (!downloadDelta.state?.current) {
		return;
	}
	await ensureRuntimeReady();

	if (downloadDelta.state.current === "complete") {
		await processPendingDownload(downloadDelta.id);
		return;
	}

	if (downloadDelta.state.current === "interrupted") {
		await processInterruptedDownload(downloadDelta.id);
	}
}

async function openScreenshotPagination(tab, command, dimensions) {
	const request = {
		id: crypto.randomUUID(),
		tab: { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title },
		documentId: dimensions.documentId,
		width: dimensions.width,
		height: dimensions.height,
		format: command.format,
		action: command.action,
		status: "choosing",
		createdAt: new Date().toISOString(),
	};
	await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: request });
	const chooser = await chrome.tabs.create({
		url: "about:blank", active: false, windowId: tab.windowId,
	});
	await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: { ...request, chooserTabId: chooser.id } });
	// Bind the sender before its script can request status from the worker.
	await chrome.tabs.update(chooser.id, {
		url: chrome.runtime.getURL(`${PAGINATION_PAGE}#${request.id}`), active: true,
	});
}

async function savePagedScreenshot(message, sender) {
	await ensureRuntimeReady();
	await refreshTranslations();
	const stored = await chrome.storage.session.get(PAGINATION_REQUEST_KEY);
	const request = stored[PAGINATION_REQUEST_KEY];
	if (!request || request.id !== message.requestId || request.status !== "choosing" || !request.documentId
		|| sender?.url?.split("#")[0] !== chrome.runtime.getURL(PAGINATION_PAGE)
		|| sender?.tab?.id !== request.chooserTabId
		|| !["longest", "a4"].includes(message.mode)) {
		throw new Error(t("paginationExpired"));
	}
	const tab = await chrome.tabs.get(request.tab.id);
	if (tab.url !== request.tab.url || tab.windowId !== request.tab.windowId) {
		throw new Error(t("errorScreenshotTabChanged"));
	}
	const directory = await loadScreenshotDirectory();
	if (!directory || await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
		throw new Error(t("paginationDirectoryPermission"));
	}
	const leaseResult = await acquireScreenshotLease({
		workerId: WORKER_INSTANCE_ID, tabId: tab.id, windowId: tab.windowId,
		tabUrl: tab.url, startedAt: new Date().toISOString(), pageState: null,
	});
	if (!leaseResult.acquired) throw new Error(t("errorScreenshotAlreadyRunning"));
	let savedCount = 0;
	let lastHistory;
	let progress;
	try {
		if (leaseResult.previousLease) await restoreScreenshotLease(leaseResult.previousLease);
		const current = (await chrome.storage.session.get(PAGINATION_REQUEST_KEY))[PAGINATION_REQUEST_KEY];
		if (current?.id !== request.id || current.status !== "choosing") {
			throw new Error(t("paginationExpired"));
		}
		progress = { ...request, status: "capturing", workerId: WORKER_INSTANCE_ID,
			savedCount: 0, directoryName: directory.name, pendingFilename: "", lastHistory: null };
		await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: progress });
		const settings = await getSettings();
		const filename = buildScreenshotDownloadPath({
			pageTitle: tab.title, pageUrl: tab.url, mode: "full-page", format: request.format,
		});
		const sink = await createScreenshotDirectorySink({ directory, filename });
		await chrome.tabs.update(tab.id, { active: true });
		const result = await captureFullPageScreenshotBlob(tab, request.format, settings, {
			pageMode: message.mode,
			documentId: request.documentId,
			onPage: async (page) => {
				progress = { ...progress, pendingFilename: sink.pageFilename(page) };
				await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: progress });
				const name = await sink.savePage(page);
				savedCount += 1;
				lastHistory = {
					id: `${request.id}-${page.index}`, status: "completed", action: "save",
					format: request.format, requestedPath: `${directory.name}/${name}`, finalPath: "",
					captureType: "screenshot", screenshotMode: "full-page",
					partialCapture: page.partial, partialReason: page.partialReason,
					capturedHeight: page.capturedHeight, totalHeight: page.totalHeight,
					createdAt: request.createdAt, finishedAt: new Date().toISOString(),
				};
				progress = { ...progress, savedCount, lastHistory, pendingFilename: "" };
				await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: progress });
				await storeSaveHistory(lastHistory);
			},
		});
		if (result.partial && lastHistory) {
			await storeSaveHistory({ ...lastHistory, partialCapture: true,
				partialReason: result.partialReason, capturedHeight: result.capturedHeight, totalHeight: result.totalHeight });
		}
		// A worker stopping during feedback must not turn a finished export into
		// an interrupted capture on the next startup.
		progress = { ...progress, status: "completed", partial: result.partial };
		await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: progress });
		await notify(
			t(result.partial ? "notifyPartialScreenshotSavedTitle" : "notifyScreenshotSavedTitle"),
			t(result.partial ? "paginationSavedPartial" : "paginationSaved", [String(savedCount), directory.name]),
			result.partial ? "warning" : "success",
		);
		return { ...result, savedCount, directoryName: directory.name };
	} catch (error) {
		const message = t("paginationFailed", [String(savedCount), getErrorMessage(error)]);
		await notify(t("notifySaveFailedTitle"), message, "error");
		throw new Error(message, { cause: error });
	} finally {
		await releaseScreenshotLease(WORKER_INSTANCE_ID);
		const current = await chrome.storage.session.get(PAGINATION_REQUEST_KEY);
		if (current[PAGINATION_REQUEST_KEY]?.id === request.id) {
			await chrome.storage.session.remove(PAGINATION_REQUEST_KEY);
		}
	}
}

async function getPagedScreenshotStatus(message, sender) {
	await ensureRuntimeReady();
	const request = (await chrome.storage.session.get(PAGINATION_REQUEST_KEY))[PAGINATION_REQUEST_KEY];
	if (!request || request.id !== message.requestId
		|| sender?.url?.split("#")[0] !== chrome.runtime.getURL(PAGINATION_PAGE)
		|| sender?.tab?.id !== request.chooserTabId) {
		throw new Error(t("paginationExpired"));
	}
	return request;
}

async function recoverInterruptedPagination() {
	let request = (await chrome.storage.session.get(PAGINATION_REQUEST_KEY))[PAGINATION_REQUEST_KEY];
	if (!request || request.workerId === WORKER_INSTANCE_ID) return;
	if (request.status === "capturing") {
		request = { ...request, status: "interrupted", finishedAt: new Date().toISOString() };
		await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: request });
	}
	if (request.status !== "interrupted" || request.interruptionReported) return;
	if (request.lastHistory) {
		await storeSaveHistory({ ...request.lastHistory, partialCapture: true,
			partialReason: PARTIAL_CAPTURE_REASONS.CAPTURE_FAILED });
	}
	let message = t("paginationInterrupted", [String(request.savedCount || 0), request.directoryName || ""]);
	if (request.pendingFilename) {
		message += ` ${t("paginationUnconfirmedPage", request.pendingFilename)}`;
	}
	await notify(t("notifySaveFailedTitle"), message, "warning", `${request.id}-interrupted`);
	const current = (await chrome.storage.session.get(PAGINATION_REQUEST_KEY))[PAGINATION_REQUEST_KEY];
	if (current?.id === request.id && current.status === "interrupted") {
		await chrome.storage.session.set({ [PAGINATION_REQUEST_KEY]: { ...current, interruptionReported: true } });
	}
}

function buildActionMenuId(format, action) {
	return `action:${format}:${action}`;
}

function buildScreenshotActionMenuId(mode, format, action) {
	return `screenshot:${mode}:${format}:${action}`;
}

function parseMenuId(menuItemId) {
	if (typeof menuItemId !== "string") {
		return null;
	}

	const parts = menuItemId.split(":");
	if (parts.length === 3 && parts[0] === "action") {
		return {
			kind: "image",
			format: parts[1],
			action: parts[2],
		};
	}

	if (parts.length === 4 && parts[0] === "screenshot") {
		if (!SCREENSHOT_MODES.some(({ id }) => id === parts[1])
			|| !FORMATS.some(({ id }) => id === parts[2])
			|| !ACTIONS.some(({ id }) => id === parts[3])) {
			return null;
		}
		return {
			kind: "screenshot",
			mode: parts[1],
			format: parts[2],
			action: parts[3],
		};
	}

	return null;
}

async function captureVisibleScreenshotBlob(tab, format, settings) {
	const dataUrl = await captureVisibleTabDataUrl(tab);
	const sourceBlob = await readDataUrlBlob(dataUrl, t);
	const converted = await convertImageBlob(sourceBlob, format, settings);
	return converted.blob;
}

async function captureRegionScreenshotBlob(tab, format, settings) {
	const region = await executeTabFunction(tab.id, selectScreenshotRegion, [
		{ instruction: t("screenshotRegionInstruction") },
		SCREENSHOT_SELECTION_TIMEOUT_MS,
	]);
	if (!region || region.cancelled) {
		return null;
	}

	const dataUrl = await captureVisibleTabDataUrl(tab);
	const bitmap = await createImageBitmap(await readDataUrlBlob(dataUrl, t));

	try {
		const source = getScreenshotRegionPixels(
			region,
			bitmap.width,
			bitmap.height,
		);
		if (!source) {
			throw new Error(t("errorScreenshotEmpty"));
		}

		validateScreenshotSize(source.width, source.height);
		const canvas = new OffscreenCanvas(source.width, source.height);
		const context = canvas.getContext("2d", getCanvasContextOptions(format));
		if (!context) {
			throw new Error(t("errorCanvasUnavailable"));
		}

		prepareCanvasForEncoding(
			context,
			format,
			source.width,
			source.height,
		);
		context.drawImage(
			bitmap,
			source.x,
			source.y,
			source.width,
			source.height,
			0,
			0,
			source.width,
			source.height,
		);

		return canvas.convertToBlob(getImageEncodeOptions(format, settings));
	} finally {
		bitmap.close();
	}
}

async function captureFullPageScreenshotBlob(tab, format, settings, options = {}) {
	let pageState = null;
	try {
		const prepared = await executeTabFunctionWithMetadata(
			tab.id, preparePageForScreenshot, [SCREENSHOT_RECOVERY_TIMEOUT_MS], options.documentId || "",
		);
		pageState = prepared?.result
			? { ...prepared.result, documentId: prepared.documentId || "" }
			: null;
		await updateScreenshotLease(WORKER_INSTANCE_ID, { pageState });
		if (!pageState?.viewportWidth || !pageState?.viewportHeight || !pageState?.pageHeight) {
			throw new Error(t("errorScreenshotMetricsUnavailable"));
		}
		const width = Math.ceil(pageState.viewportWidth * pageState.devicePixelRatio);
		const height = Math.ceil(pageState.pageHeight * pageState.devicePixelRatio);
		if (!options.pageMode && !canCaptureSingleImage(width, height, format)) {
			throw new ScreenshotPaginationRequired(width, height, format);
		}
		let blob;
		const result = await captureScreenshotFrames({
			pageState, format, settings,
			mode: options.pageMode || "single",
			classifyCaptureError: getPartialCaptureReason,
			messages: {
				scrollStalled: t("errorScreenshotScrollStalled"),
				viewportChanged: t("errorScreenshotViewportChanged"),
			},
			scroll: async (requestedScrollY) => {
				const state = await executeTabFunction(
					tab.id, scrollPageForScreenshot, [pageState, requestedScrollY], pageState.documentId,
				);
				ensureScreenshotDocumentUnchanged(state);
				return state;
			},
			capture: async () => {
				const dataUrl = await captureVisibleTabDataUrl(tab);
				await ensureScreenshotPageCurrent(tab.id, pageState);
				return createImageBitmap(await readDataUrlBlob(dataUrl, t));
			},
			onPage: options.onPage || (async (page) => { blob = page.blob; }),
		});
		return { ...result, blob };
	} catch (error) {
		if (error instanceof ScreenshotPaginationRequired) {
			error.documentId = pageState?.documentId || "";
		}
		throw error;
	} finally {
		if (pageState) {
			await executeTabFunction(
				tab.id, restorePageAfterScreenshot, [pageState], pageState.documentId,
			).catch(() => {});
		}
	}
}

function getPartialCaptureReason(error) {
	if (error instanceof RecoverableScreenshotError) {
		return error.partialReason;
	}

	if (
		error instanceof TypeError ||
		error instanceof ReferenceError ||
		error instanceof SyntaxError ||
		error instanceof RangeError
	) {
		return "";
	}

	return PARTIAL_CAPTURE_REASONS.CAPTURE_FAILED;
}

async function recoverStaleScreenshotLease() {
	const staleLease = await takeStaleScreenshotLease(WORKER_INSTANCE_ID);
	if (staleLease) {
		await restoreScreenshotLease(staleLease);
	}
}

async function restoreScreenshotLease(lease) {
	if (!Number.isInteger(lease?.tabId) || !lease?.pageState) {
		return;
	}

	const tab = await chrome.tabs.get(lease.tabId).catch(() => null);
	if (!tab || (lease.tabUrl && tab.url !== lease.tabUrl)) {
		return;
	}

	await executeTabFunction(
		lease.tabId,
		restorePageAfterScreenshot,
		[lease.pageState],
		lease.pageState.documentId,
	).catch(() => {});
}

async function executeTabFunction(tabId, func, args = [], documentId = "") {
	const result = await executeTabFunctionWithMetadata(
		tabId,
		func,
		args,
		documentId,
	);
	return result?.result;
}

async function executeTabFunctionWithMetadata(
	tabId,
	func,
	args = [],
	documentId = "",
) {
	const target = { tabId };
	if (documentId) {
		target.documentIds = [documentId];
	}
	const [result] = await chrome.scripting.executeScript({
		target,
		func,
		args,
	});

	return result;
}

function captureVisibleTabDataUrl(tab) {
	const operation = captureCallQueue.catch(() => {}).then(async () => {
		await ensureTabStillActive(tab);
		await waitForScreenshotCaptureSlot(CAPTURE_INTERVAL_MS);
		await ensureTabStillActive(tab);
		const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
			format: "png",
		});
		await ensureTabStillActive(tab);
		return dataUrl;
	});
	captureCallQueue = operation;
	return operation;
}

async function ensureTabStillActive(tab) {
	const [activeTab] = await chrome.tabs.query({
		active: true,
		windowId: tab.windowId,
	});

	if (activeTab?.id !== tab.id || (tab.url && activeTab.url !== tab.url)) {
		throw new RecoverableScreenshotError(
			PARTIAL_CAPTURE_REASONS.TAB_CHANGED,
			t("errorScreenshotTabChanged"),
		);
	}
}

function ensureScreenshotDocumentUnchanged(scrollState) {
	if (scrollState?.documentChanged) {
		throw new RecoverableScreenshotError(
			PARTIAL_CAPTURE_REASONS.TAB_CHANGED,
			t("errorScreenshotTabChanged"),
		);
	}
}

async function ensureScreenshotPageCurrent(tabId, pageState) {
	let isCurrent = false;
	try {
		isCurrent = await executeTabFunction(
			tabId,
			isPagePreparedForScreenshot,
			[pageState],
			pageState.documentId,
		);
	} catch {
		isCurrent = false;
	}

	if (!isCurrent) {
		throw new RecoverableScreenshotError(
			PARTIAL_CAPTURE_REASONS.TAB_CHANGED,
			t("errorScreenshotTabChanged"),
		);
	}
}

function validateScreenshotSize(width, height) {
	if (!width || !height) {
		throw new Error(t("errorScreenshotEmpty"));
	}

	if (width > MAX_SCREENSHOT_EDGE || height > MAX_SCREENSHOT_EDGE) {
		throw new Error(
			t("errorScreenshotTooLargeEdge", String(MAX_SCREENSHOT_EDGE)),
		);
	}

	if (width * height > MAX_SCREENSHOT_PIXELS) {
		throw new Error(t("errorScreenshotTooLargePixels"));
	}
}

async function downloadBlob(blob, filename, silentSave) {
	const objectUrl = await createBlobUrl(blob);

	try {
		const downloadId = await startDownload(objectUrl, filename, !silentSave);

		if (!Number.isInteger(downloadId)) {
			throw new Error(t("errorDownloadStartFailed"));
		}

		return {
			downloadId,
			objectUrl,
		};
	} catch (error) {
		await revokeBlobUrl(objectUrl);
		throw new Error(t("errorDownloadStartFailed"), { cause: error });
	}
}

function startDownload(objectUrl, filename, saveAs) {
	return chrome.downloads.download({
		url: objectUrl,
		filename,
		saveAs,
		conflictAction: "uniquify",
	});
}

async function queuePendingDownload(downloadId, payload) {
	try {
		await setPendingDownload(downloadId, payload);
	} catch (error) {
		await chrome.downloads.cancel(downloadId).catch(() => {});
		await revokePendingObjectUrl(payload);
		throw error;
	}
}

async function getDownloadItem(downloadId) {
	const [downloadItem] = await chrome.downloads.search({ id: downloadId });
	return downloadItem;
}

async function recoverPendingDownloads() {
	const pendingDownloads = await listPendingDownloads();

	for (const { downloadId, payload } of pendingDownloads) {
		try {
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				await deletePendingDownload(downloadId);
				continue;
			}

			if (payload.cleanupOnly) {
				await processPendingDownload(downloadId);
				continue;
			}

			const downloadItem = await getDownloadItem(downloadId);
			if (
				downloadItem?.state === "complete" ||
				downloadItem?.state === "interrupted"
			) {
				await processPendingDownload(downloadId);
				continue;
			}

			if (!downloadItem) {
				await interruptPendingDownload(downloadId, payload);
			}
		} catch (error) {
			console.error(`Failed to recover pending download ${downloadId}.`, error);
		}
	}
}

function processPendingDownload(downloadId) {
	const key = String(downloadId);
	const previous = downloadProcessingQueues.get(key) || Promise.resolve();
	const current = previous
		.catch(() => {})
		.then(() => processDownloadFinalState(downloadId));
	const tracked = current.finally(() => {
		if (downloadProcessingQueues.get(key) === tracked) {
			downloadProcessingQueues.delete(key);
		}
	});
	downloadProcessingQueues.set(key, tracked);
	return tracked;
}

function processInterruptedDownload(downloadId) {
	return processPendingDownload(downloadId);
}

async function processDownloadFinalState(downloadId) {
	const pending = await getPendingDownload(downloadId);
	if (!pending) {
		return;
	}
	if (pending.cleanupOnly) {
		await finalizePendingCleanup(downloadId, pending);
		return;
	}

	const downloadItem = await getDownloadItem(downloadId);
	if (downloadItem?.state === "complete") {
		await completePendingDownload(downloadId, pending, downloadItem);
		return;
	}

	if (downloadItem?.state === "interrupted") {
		await interruptPendingDownload(downloadId, pending);
	}
}

async function completePendingDownload(downloadId, pending, downloadItem) {
	let copiedPath = false;
	let errorMessage = "";
	const finalPath = downloadItem.filename || "";

	if (pending.action === "copy-path") {
		try {
			if (!finalPath) {
				throw new Error(t("errorMissingFinalPath"));
			}

			await copyTextToClipboard(finalPath);
			copiedPath = true;
		} catch (error) {
			errorMessage = getErrorMessage(error);
		}
	}

	await storeSaveHistory({
		id: pending.historyId || `download-${downloadId}`,
		status: "completed",
		action: pending.action,
		format: pending.format,
		requestedPath: pending.requestedPath,
		finalPath,
		copiedPath,
		error: errorMessage,
		captureType: pending.captureType || "image",
		screenshotMode: pending.screenshotMode || "",
		partialCapture: Boolean(pending.partialCapture),
		partialReason: pending.partialReason,
		capturedHeight: pending.capturedHeight,
		totalHeight: pending.totalHeight,
		createdAt: pending.createdAt,
		finishedAt: new Date().toISOString(),
	});

	const savedTitle =
		pending.captureType === "screenshot"
			? t("notifyScreenshotSavedTitle")
			: t("notifyImageSavedTitle");
	const savedMessage =
		pending.captureType === "screenshot"
			? t("notifyScreenshotSavedMessage", labelForFormat(pending.format))
				: t("notifyImageSavedMessage", labelForFormat(pending.format));
	const activityId = `download-${pending.historyId || downloadId}`;

	if (pending.partialCapture && pending.action === "copy-path" && copiedPath) {
		await notify(
			t("notifyPartialScreenshotSavedTitle"),
			t(
				"notifyPartialScreenshotSavedAndCopiedMessage",
				labelForFormat(pending.format),
			),
			"warning",
			activityId,
		);
	} else if (
		pending.partialCapture &&
		pending.action === "copy-path" &&
		errorMessage
	) {
		await notify(
			t("notifyPartialScreenshotSavedTitle"),
			t("notifyPartialScreenshotSavedCopyFailedMessage", [
				labelForFormat(pending.format),
				errorMessage,
			]),
			"error",
			activityId,
		);
	} else if (pending.partialCapture) {
		await notify(
			t("notifyPartialScreenshotSavedTitle"),
			t("notifyPartialScreenshotSavedMessage", labelForFormat(pending.format)),
			"warning",
			activityId,
		);
	} else if (pending.action === "copy-path" && copiedPath) {
		await notify(
			t("notifySavedAndCopiedTitle"),
			t("notifySavedAndCopiedMessage", labelForFormat(pending.format)),
			"success",
			activityId,
		);
	} else if (pending.action === "copy-path" && errorMessage) {
		await notify(
			savedTitle,
			t("notifySavedCopyFailedMessage", [
				labelForFormat(pending.format),
				errorMessage,
			]),
			"error",
			activityId,
		);
	} else {
		await notify(savedTitle, savedMessage, "success", activityId);
	}

	await finalizePendingCleanup(downloadId, pending);
}

async function interruptPendingDownload(downloadId, pending) {
	await storeSaveHistory({
		id: pending.historyId || `download-${downloadId}`,
		status: "interrupted",
		action: pending.action,
		format: pending.format,
		requestedPath: pending.requestedPath,
		finalPath: "",
		copiedPath: false,
		error: t("errorDownloadInterrupted"),
		captureType: pending.captureType || "image",
		screenshotMode: pending.screenshotMode || "",
		partialCapture: false,
		partialReason: "",
		capturedHeight: 0,
		totalHeight: 0,
		createdAt: pending.createdAt,
		finishedAt: new Date().toISOString(),
	});

	await notify(
		t("notifySaveFailedTitle"),
		t("notifyInterruptedMessage"),
		"error",
		`download-${pending.historyId || downloadId}`,
	);

	await finalizePendingCleanup(downloadId, pending);
}

async function revokePendingObjectUrl(pending) {
	if (!pending?.objectUrl) {
		return true;
	}

	try {
		await revokeBlobUrl(pending.objectUrl);
		return true;
	} catch (error) {
		console.error("Failed to revoke a pending download blob URL.", error);
		return false;
	}
}

async function finalizePendingCleanup(downloadId, pending) {
	const cleanupPending = {
		...(pending && typeof pending === "object" ? pending : {}),
		cleanupOnly: true,
	};

	if (!pending?.cleanupOnly) {
		await setPendingDownload(downloadId, cleanupPending);
	}

	if (await revokePendingObjectUrl(cleanupPending)) {
		await deletePendingDownload(downloadId);
	}
}

async function acknowledgeReapedBlobUrl(objectUrl) {
	try {
		if (typeof objectUrl !== "string" || !objectUrl) {
			return;
		}

		const pendingDownloads = await listPendingDownloads();
		for (const { downloadId, payload } of pendingDownloads) {
			if (payload?.cleanupOnly && payload.objectUrl === objectUrl) {
				await deletePendingDownload(downloadId);
			}
		}
	} finally {
		await closeOffscreenDocumentIfIdle().catch(() => {});
	}
}

async function canReapBlobUrl(objectUrl) {
	if (typeof objectUrl !== "string" || !objectUrl) {
		return false;
	}

	const matches = (await listPendingDownloads()).filter(
		({ payload }) => payload?.objectUrl === objectUrl,
	);
	return (
		matches.length > 0 && matches.every(({ payload }) => payload.cleanupOnly)
	);
}

function labelForFormat(format) {
	const normalizedFormat = typeof format === "string" ? format : "";
	return (
		FORMATS.find((item) => item.id === normalizedFormat)?.title ||
		normalizedFormat.toUpperCase() ||
		"IMAGE"
	);
}

async function notify(
	title,
	message,
	status = "success",
	activityId = crypto.randomUUID(),
) {
	await storeActivity({
		id: activityId,
		title,
		message,
		status,
		createdAt: new Date().toISOString(),
	});

	const badgeFeedback = {
		error: { color: "#b42318", text: "ERR" },
		warning: { color: "#a15c00", text: "PART" },
		success: { color: "#1d6f42", text: "OK" },
	}[status] || { color: "#1d6f42", text: "OK" };
	const feedbackResults = await Promise.allSettled([
		chrome.action.setBadgeBackgroundColor({
			color: badgeFeedback.color,
		}),
		chrome.action.setBadgeText({
			text: badgeFeedback.text,
		}),
		chrome.action.setTitle({
			title: `${title}\n${message}`,
		}),
		chrome.notifications.create(activityId, {
			type: "basic",
			iconUrl: chrome.runtime.getURL("assets/icons/icon-128.png"),
			title,
			message,
		}),
	]);
	for (const result of feedbackResults) {
		if (result.status === "rejected") {
			console.error(result.reason);
		}
	}

	clearTimeout(badgeResetTimeoutId);
	badgeResetTimeoutId = setTimeout(() => {
		void Promise.allSettled([
			chrome.action.setBadgeText({ text: "" }),
			chrome.action.setTitle({ title: t("extActionTitle") }),
		]);
	}, 8000);
}

function getErrorMessage(error) {
	const localizedImageErrorKey = {
		[IMAGE_ERROR_CODES.UNSUPPORTED_FORMAT]: "errorUnsupportedImageFormat",
		[IMAGE_ERROR_CODES.SOURCE_TOO_LARGE]: "errorSourceImageTooLarge",
		[IMAGE_ERROR_CODES.IMAGE_DECODE_FAILED]: "errorImageDecodeFailed",
		[IMAGE_ERROR_CODES.IMAGE_EMPTY]: "errorImageEmpty",
		[IMAGE_ERROR_CODES.IMAGE_TOO_LARGE]: "errorImageDimensionsTooLarge",
		[IMAGE_ERROR_CODES.CANVAS_UNAVAILABLE]: "errorCanvasUnavailable",
		[IMAGE_ERROR_CODES.IMAGE_ENCODE_FAILED]: "errorImageEncodeFailed",
	}[error?.code];
	if (localizedImageErrorKey) {
		return t(localizedImageErrorKey);
	}

	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	return t("errorUnknown");
}

function t(messageName, substitutions) {
	return translate(messageName, substitutions) || messageName;
}

async function refreshTranslations(settings) {
	const nextSettings = settings || (await getSettings());
	if (nextSettings.localeOverride === activeLocaleOverride) {
		return;
	}

	const translator = await getTranslator(nextSettings.localeOverride);
	activeLocaleOverride = nextSettings.localeOverride;
	translate = translator.t;

	await Promise.all([
		chrome.action.setTitle({
			title: t("extActionTitle"),
		}),
		chrome.action.setBadgeText({ text: "" }),
	]);
}

async function setTrustedStorageAccess() {
	await Promise.all([
		chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
		chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
	]);
}

async function reportBackgroundError(error) {
	console.error(error);
	try {
		await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
	} catch (notificationError) {
		console.error(notificationError);
	}
}
