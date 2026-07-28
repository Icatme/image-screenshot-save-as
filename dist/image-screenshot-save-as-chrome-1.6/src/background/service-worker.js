import {
	copyTextToClipboard,
	createBlobUrl,
	revokeBlobUrl,
} from "../lib/clipboard.js";
import {
	buildDownloadPath,
	buildScreenshotDownloadPath,
} from "../lib/file-name.js";
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
import { getSettings } from "../lib/settings.js";
import {
	isPagePreparedForScreenshot,
	preparePageForScreenshot,
	restorePageAfterScreenshot,
	scrollPageForScreenshot,
} from "../lib/screenshot-page.js";
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
// Throttle between captureVisibleTab calls to avoid overwhelming the API and allow
// the page to settle after scrolling (Chrome's capture is not instantaneous).
const CAPTURE_INTERVAL_MS = 550;
const MAX_SCREENSHOT_EDGE = 32767;
const MAX_SCREENSHOT_PIXELS = 100_000_000;
const SCREENSHOT_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;
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
	if (message?.type !== "CLEAR_SAVE_HISTORY") {
		return false;
	}

	void clearSaveHistory()
		.then(() => sendResponse({ ok: true }))
		.catch((error) => {
			sendResponse({ ok: false, error: getErrorMessage(error) });
		});
	return true;
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
	await recoverPendingDownloads();
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
		await handleScreenshotMenuClick(command, tab);
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

	try {
		const settings = await getSettings();
		await refreshTranslations(settings);
		const sourceBlob = await getSourceImageBlob(
			info.srcUrl,
			tab?.id,
			info.frameId,
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

async function handleScreenshotMenuClick(command, tab) {
	if (tab?.id == null || tab?.windowId == null) {
		await notify(
			t("notifySaveFailedTitle"),
			t("errorScreenshotNoTab"),
			"error",
		);
		return;
	}

	try {
		await ensureFileSchemeAccess(tab.url, t);
	} catch (error) {
		await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
		return;
	}

	const lease = {
		workerId: WORKER_INSTANCE_ID,
		tabId: tab.id,
		windowId: tab.windowId,
		tabUrl: tab.url || "",
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
		const sourceBlob =
			command.mode === "full-page"
				? await captureFullPageScreenshotBlob(tab, command.format, settings)
				: await captureVisibleScreenshotBlob(tab, command.format, settings);
		const downloadPath = buildScreenshotDownloadPath({
			pageTitle: tab.title ?? "",
			pageUrl: tab.url ?? "",
			mode: command.mode,
			format: command.format,
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
			format: command.format,
			requestedPath: downloadPath,
			objectUrl: downloadResult.objectUrl,
			createdAt: new Date().toISOString(),
		});

		await processPendingDownload(downloadId);
	} catch (error) {
		await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
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

async function captureFullPageScreenshotBlob(tab, format, settings) {
	let pageState = null;
	let canvas = null;
	let context = null;
	let scaleY = 1;
	let capturedCssHeight = 0;

	try {
		const prepared = await executeTabFunctionWithMetadata(
			tab.id,
			preparePageForScreenshot,
			[
			SCREENSHOT_RECOVERY_TIMEOUT_MS,
			],
		);
		pageState = prepared?.result
			? { ...prepared.result, documentId: prepared.documentId || "" }
			: prepared?.result;
		await updateScreenshotLease(WORKER_INSTANCE_ID, { pageState });
		if (
			!pageState?.viewportWidth ||
			!pageState?.viewportHeight ||
			!pageState?.pageHeight
		) {
			throw new Error(t("errorScreenshotMetricsUnavailable"));
		}

		validateScreenshotSize(
			Math.ceil(pageState.viewportWidth * pageState.devicePixelRatio),
			Math.ceil(pageState.pageHeight * pageState.devicePixelRatio),
		);

		if (pageState.scrollTarget === "element") {
			return await captureScrollableElementScreenshotBlob(
				tab,
				pageState,
				format,
				settings,
			);
		}

		while (capturedCssHeight < pageState.pageHeight) {
			const requestedScrollY = Math.min(
				capturedCssHeight,
				pageState.maxScrollY,
			);
			const scrollState = await executeTabFunction(
				tab.id,
				scrollPageForScreenshot,
				[pageState, requestedScrollY],
				pageState.documentId,
			);
			ensureScreenshotDocumentUnchanged(scrollState);
			const dataUrl = await captureVisibleTabDataUrl(tab);
			await ensureScreenshotPageCurrent(tab.id, pageState);
			const bitmap = await createImageBitmap(await readDataUrlBlob(dataUrl, t));

			try {
				if (!canvas) {
					const scaleX = bitmap.width / pageState.viewportWidth;
					scaleY = bitmap.height / pageState.viewportHeight;
					const outputWidth = Math.round(pageState.viewportWidth * scaleX);
					const outputHeight = Math.round(pageState.pageHeight * scaleY);

					validateScreenshotSize(outputWidth, outputHeight);
					canvas = new OffscreenCanvas(outputWidth, outputHeight);
					context = canvas.getContext("2d", getCanvasContextOptions(format));

					if (!context) {
						throw new Error(t("errorCanvasUnavailable"));
					}

					prepareCanvasForEncoding(
						context,
						format,
						outputWidth,
						outputHeight,
					);
				}

				const actualScrollY = Number(scrollState?.scrollY) || 0;
				const cropTopCss = Math.max(0, capturedCssHeight - actualScrollY);
				const drawableCssHeight = Math.min(
					pageState.viewportHeight - cropTopCss,
					pageState.pageHeight - capturedCssHeight,
				);

				if (drawableCssHeight <= 0) {
					throw new Error(t("errorScreenshotScrollStalled"));
				}

				const sourceY = Math.round(cropTopCss * scaleY);
				const sourceHeight = Math.min(
					bitmap.height - sourceY,
					Math.round(drawableCssHeight * scaleY),
				);
				const targetY = Math.round(capturedCssHeight * scaleY);
				const targetHeight = Math.min(sourceHeight, canvas.height - targetY);

				if (targetHeight <= 0) {
					throw new Error(t("errorScreenshotScrollStalled"));
				}

				context.drawImage(
					bitmap,
					0,
					sourceY,
					bitmap.width,
					targetHeight,
					0,
					targetY,
					canvas.width,
					targetHeight,
				);

				capturedCssHeight += drawableCssHeight;
			} finally {
				bitmap.close();
			}
		}

		return canvas.convertToBlob(getImageEncodeOptions(format, settings));
	} finally {
		if (pageState) {
			await executeTabFunction(
				tab.id,
				restorePageAfterScreenshot,
				[pageState],
				pageState.documentId,
			).catch(() => {});
		}
	}
}

async function captureScrollableElementScreenshotBlob(
	tab,
	pageState,
	format,
	settings,
) {
	let canvas = null;
	let context = null;
	let scaleY = 1;
	let capturedElementContentHeight = 0;

	while (capturedElementContentHeight < pageState.elementScrollHeight) {
		const requestedScrollY = Math.min(
			capturedElementContentHeight,
			pageState.maxScrollY,
		);
		const scrollState = await executeTabFunction(
			tab.id,
			scrollPageForScreenshot,
			[pageState, requestedScrollY],
			pageState.documentId,
		);
		ensureScreenshotDocumentUnchanged(scrollState);
		const dataUrl = await captureVisibleTabDataUrl(tab);
		await ensureScreenshotPageCurrent(tab.id, pageState);
		const bitmap = await createImageBitmap(await readDataUrlBlob(dataUrl, t));

		try {
			if (!canvas) {
				const scaleX = bitmap.width / pageState.viewportWidth;
				scaleY = bitmap.height / pageState.viewportHeight;
				const outputWidth = Math.round(pageState.viewportWidth * scaleX);
				const outputHeight = Math.round(pageState.pageHeight * scaleY);

				validateScreenshotSize(outputWidth, outputHeight);
				canvas = new OffscreenCanvas(outputWidth, outputHeight);
				context = canvas.getContext("2d", getCanvasContextOptions(format));

				if (!context) {
					throw new Error(t("errorCanvasUnavailable"));
				}

				prepareCanvasForEncoding(
					context,
					format,
					outputWidth,
					outputHeight,
				);
			}

			if (capturedElementContentHeight === 0) {
				context.drawImage(
					bitmap,
					0,
					0,
					bitmap.width,
					bitmap.height,
					0,
					0,
					canvas.width,
					bitmap.height,
				);
				capturedElementContentHeight = Math.min(
					pageState.elementViewportHeight,
					pageState.elementScrollHeight,
				);
				continue;
			}

			const actualScrollY = Number(scrollState?.scrollY) || 0;
			const cropTopInElementCss = Math.max(
				0,
				capturedElementContentHeight - actualScrollY,
			);
			const drawableCssHeight = Math.min(
				pageState.elementViewportHeight - cropTopInElementCss,
				pageState.elementScrollHeight - capturedElementContentHeight,
			);

			if (drawableCssHeight <= 0) {
				throw new Error(t("errorScreenshotScrollStalled"));
			}

			const sourceY = Math.round(
				(pageState.elementTop + cropTopInElementCss) * scaleY,
			);
			const sourceHeight = Math.min(
				bitmap.height - sourceY,
				Math.round(drawableCssHeight * scaleY),
			);
			const targetY = Math.round(
				(pageState.viewportHeight +
					capturedElementContentHeight -
					pageState.elementViewportHeight) *
					scaleY,
			);
			const targetHeight = Math.min(sourceHeight, canvas.height - targetY);

			if (targetHeight <= 0) {
				throw new Error(t("errorScreenshotScrollStalled"));
			}

			context.drawImage(
				bitmap,
				0,
				sourceY,
				bitmap.width,
				targetHeight,
				0,
				targetY,
				canvas.width,
				targetHeight,
			);

			capturedElementContentHeight += drawableCssHeight;
		} finally {
			bitmap.close();
		}
	}

	return canvas.convertToBlob(getImageEncodeOptions(format, settings));
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
		throw new Error(t("errorScreenshotTabChanged"));
	}
}

function ensureScreenshotDocumentUnchanged(scrollState) {
	if (scrollState?.documentChanged) {
		throw new Error(t("errorScreenshotTabChanged"));
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
		throw new Error(t("errorScreenshotTabChanged"));
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
		const downloadItem = await getDownloadItem(downloadId);
		if (downloadItem?.state === "complete" || downloadItem?.state === "interrupted") {
			await processPendingDownload(downloadId);
			continue;
		}

		if (!downloadItem) {
			await interruptPendingDownload(downloadId, payload);
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
	await revokePendingObjectUrl(pending);

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

	if (pending.action === "copy-path" && copiedPath) {
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

	await deletePendingDownload(downloadId);
}

async function interruptPendingDownload(downloadId, pending) {
	await revokePendingObjectUrl(pending);

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
		createdAt: pending.createdAt,
		finishedAt: new Date().toISOString(),
	});

	await notify(
		t("notifySaveFailedTitle"),
		t("notifyInterruptedMessage"),
		"error",
		`download-${pending.historyId || downloadId}`,
	);

	await deletePendingDownload(downloadId);
}

async function revokePendingObjectUrl(pending) {
	if (!pending?.objectUrl) {
		return;
	}

	try {
		await revokeBlobUrl(pending.objectUrl);
	} catch {
		// Ignore cleanup failures. The download has already finished or stopped.
	}
}

function labelForFormat(format) {
	return (
		FORMATS.find((item) => item.id === format)?.title || format.toUpperCase()
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


	const feedbackResults = await Promise.allSettled([
		chrome.action.setBadgeBackgroundColor({
			color: status === "error" ? "#b42318" : "#1d6f42",
		}),
		chrome.action.setBadgeText({
			text: status === "error" ? "ERR" : "OK",
		}),
		chrome.action.setTitle({
			title: `${title}\n${message}`,
		}),
		chrome.notifications.create(activityId, {
			type: "basic",
			iconUrl: "assets/icons/icon-128.png",
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
