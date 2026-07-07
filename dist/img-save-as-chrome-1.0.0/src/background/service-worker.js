import { copyTextToClipboard, createBlobUrl, revokeBlobUrl } from "../lib/clipboard.js";
import { buildDownloadPath, buildScreenshotDownloadPath } from "../lib/file-name.js";
import { getTranslator } from "../lib/i18n.js";
import { convertImageBlob } from "../lib/image-convert.js";
import { getSettings } from "../lib/settings.js";

const ROOT_MENU_ID = "img-save-as";
const SCREENSHOT_MENU_ID = "page-screenshot-as";
const PENDING_DOWNLOADS_KEY = "pendingDownloads";
const RECENT_ACTIVITY_KEY = "recentActivity";
const SAVE_HISTORY_KEY = "saveHistory";
const CAPTURE_INTERVAL_MS = 550;
const SAVE_AS_PROMPT_BLOCKED_MS = 500;
const MAX_SCREENSHOT_EDGE = 32767;
const MAX_SCREENSHOT_PIXELS = 100_000_000;
const processingDownloads = new Set();
const activeScreenshotTabs = new Set();
let lastTabCaptureAt = 0;
let activeLocaleOverride = null;
let activeLocale = "en";
let translate = (messageName) => messageName;

const FORMATS = [
  { id: "png", title: "PNG" },
  { id: "jpg", title: "JPG" },
  { id: "webp", title: "WebP" }
];

const ACTIONS = [
  { id: "save", titleKey: "menuActionSave" },
  { id: "copy-path", titleKey: "menuActionCopyPath" }
];

const SCREENSHOT_MODES = [
  { id: "visible", titleKey: "menuScreenshotVisible" },
  { id: "full-page", titleKey: "menuScreenshotFullPage" }
];

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  void createContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(info, tab);
});

chrome.downloads.onChanged.addListener((downloadDelta) => {
  void handleDownloadChanged(downloadDelta);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.localeOverride) {
    void refreshTranslations();
    void createContextMenus();
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

async function initializeExtension() {
  await refreshTranslations();
  await createContextMenus();
  const sessionData = await chrome.storage.session.get(PENDING_DOWNLOADS_KEY);
  if (!sessionData[PENDING_DOWNLOADS_KEY]) {
    await chrome.storage.session.set({ [PENDING_DOWNLOADS_KEY]: {} });
  }
}

async function createContextMenus() {
  await refreshTranslations();
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: ROOT_MENU_ID,
    title: t("menuRoot"),
    contexts: ["image"]
  });

  for (const format of FORMATS) {
    const formatMenuId = `format:${format.id}`;
    chrome.contextMenus.create({
      id: formatMenuId,
      parentId: ROOT_MENU_ID,
      title: format.title,
      contexts: ["image"]
    });

    for (const action of ACTIONS) {
      chrome.contextMenus.create({
        id: buildActionMenuId(format.id, action.id),
        parentId: formatMenuId,
        title: t(action.titleKey),
        contexts: ["image"]
      });
    }
  }

  chrome.contextMenus.create({
    id: SCREENSHOT_MENU_ID,
    title: t("menuScreenshotRoot"),
    contexts: ["page"]
  });

  for (const mode of SCREENSHOT_MODES) {
    const modeMenuId = `screenshot-mode:${mode.id}`;
    chrome.contextMenus.create({
      id: modeMenuId,
      parentId: SCREENSHOT_MENU_ID,
      title: t(mode.titleKey),
      contexts: ["page"]
    });

    for (const format of FORMATS) {
      const formatMenuId = `screenshot-format:${mode.id}:${format.id}`;
      chrome.contextMenus.create({
        id: formatMenuId,
        parentId: modeMenuId,
        title: format.title,
        contexts: ["page"]
      });

      for (const action of ACTIONS) {
        chrome.contextMenus.create({
          id: buildScreenshotActionMenuId(mode.id, format.id, action.id),
          parentId: formatMenuId,
          title: t(action.titleKey),
          contexts: ["page"]
        });
      }
    }
  }
}

async function handleMenuClick(info, tab) {
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
    await notify(t("notifySaveFailedTitle"), t("notifySaveFailedNoImageUrl"), "error");
    return;
  }

  try {
    const settings = await getSettings();
    await refreshTranslations(settings);
    const sourceBlob = await getSourceImageBlob(info.srcUrl, tab?.id, info.frameId);
    const converted = await convertImageBlob(sourceBlob, command.format, settings);
    const downloadPath = buildDownloadPath({
      srcUrl: info.srcUrl,
      pageTitle: tab?.title ?? "",
      format: command.format
    });
    const downloadResult = await downloadBlob(converted.blob, downloadPath, settings.silentSave);
    const downloadId = downloadResult?.downloadId ?? null;

    if (downloadId === null) {
      return;
    }

    await queuePendingDownload(downloadId, {
      action: command.action,
      format: command.format,
      pageTitle: tab?.title ?? "",
      srcUrl: info.srcUrl,
      requestedPath: downloadPath,
      objectUrl: downloadResult.objectUrl,
      createdAt: new Date().toISOString()
    });

    await processPendingDownload(downloadId);
  } catch (error) {
    await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
  }
}

async function handleScreenshotMenuClick(command, tab) {
  if (tab?.id == null || tab?.windowId == null) {
    await notify(t("notifySaveFailedTitle"), t("errorScreenshotNoTab"), "error");
    return;
  }

  try {
    await ensureFileSchemeAccess(tab.url);
  } catch (error) {
    await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
    return;
  }

  const tabKey = String(tab.id);
  if (activeScreenshotTabs.has(tabKey)) {
    await notify(t("notifySaveFailedTitle"), t("errorScreenshotAlreadyRunning"), "error");
    return;
  }

  activeScreenshotTabs.add(tabKey);

  try {
    const settings = await getSettings();
    await refreshTranslations(settings);
    const sourceBlob = command.mode === "full-page"
      ? await captureFullPageScreenshotBlob(tab, command.format, settings)
      : await captureVisibleScreenshotBlob(tab, command.format, settings);
    const downloadPath = buildScreenshotDownloadPath({
      pageTitle: tab.title ?? "",
      pageUrl: tab.url ?? "",
      mode: command.mode,
      format: command.format
    });
    const downloadResult = await downloadBlob(sourceBlob, downloadPath, settings.silentSave, {
      retryWithoutSaveDialog: !settings.silentSave
    });
    const downloadId = downloadResult?.downloadId ?? null;

    if (downloadId === null) {
      return;
    }

    await queuePendingDownload(downloadId, {
      action: command.action,
      captureType: "screenshot",
      screenshotMode: command.mode,
      format: command.format,
      pageTitle: tab.title ?? "",
      srcUrl: tab.url ?? "",
      requestedPath: downloadPath,
      objectUrl: downloadResult.objectUrl,
      usedSilentFallback: downloadResult.usedSilentFallback,
      createdAt: new Date().toISOString()
    });

    await processPendingDownload(downloadId);
  } catch (error) {
    await notify(t("notifySaveFailedTitle"), getErrorMessage(error), "error");
  } finally {
    activeScreenshotTabs.delete(tabKey);
  }
}

async function handleDownloadChanged(downloadDelta) {
  if (!downloadDelta.state?.current) {
    return;
  }

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
      action: parts[2]
    };
  }

  if (parts.length === 4 && parts[0] === "screenshot") {
    return {
      kind: "screenshot",
      mode: parts[1],
      format: parts[2],
      action: parts[3]
    };
  }

  return null;
}

async function captureVisibleScreenshotBlob(tab, format, settings) {
  const dataUrl = await captureVisibleTabDataUrl(tab);
  const sourceBlob = await dataUrlToBlob(dataUrl);
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
    pageState = await executeTabFunction(tab.id, preparePageForScreenshot);
    if (!pageState?.viewportWidth || !pageState?.viewportHeight || !pageState?.pageHeight) {
      throw new Error(t("errorScreenshotMetricsUnavailable"));
    }

    validateScreenshotSize(
      Math.ceil(pageState.viewportWidth * pageState.devicePixelRatio),
      Math.ceil(pageState.pageHeight * pageState.devicePixelRatio)
    );

    if (pageState.scrollTarget === "element") {
      return await captureScrollableElementScreenshotBlob(tab, pageState, format, settings);
    }

    while (capturedCssHeight < pageState.pageHeight) {
      const requestedScrollY = Math.min(capturedCssHeight, pageState.maxScrollY);
      const scrollState = await executeTabFunction(tab.id, scrollPageForScreenshot, [pageState, requestedScrollY]);
      const dataUrl = await captureVisibleTabDataUrl(tab);
      const bitmap = await createImageBitmap(await dataUrlToBlob(dataUrl));

      try {
        if (!canvas) {
          const scaleX = bitmap.width / pageState.viewportWidth;
          scaleY = bitmap.height / pageState.viewportHeight;
          const outputWidth = Math.round(pageState.viewportWidth * scaleX);
          const outputHeight = Math.round(pageState.pageHeight * scaleY);

          validateScreenshotSize(outputWidth, outputHeight);
          canvas = new OffscreenCanvas(outputWidth, outputHeight);
          context = canvas.getContext("2d", { alpha: format === "png" });

          if (!context) {
            throw new Error(t("errorCanvasUnavailable"));
          }

          if (format === "jpg") {
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, outputWidth, outputHeight);
          }
        }

        const actualScrollY = Number(scrollState?.scrollY) || 0;
        const cropTopCss = Math.max(0, capturedCssHeight - actualScrollY);
        const drawableCssHeight = Math.min(
          pageState.viewportHeight - cropTopCss,
          pageState.pageHeight - capturedCssHeight
        );

        if (drawableCssHeight <= 0) {
          throw new Error(t("errorScreenshotScrollStalled"));
        }

        const sourceY = Math.round(cropTopCss * scaleY);
        const sourceHeight = Math.min(bitmap.height - sourceY, Math.round(drawableCssHeight * scaleY));
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
          targetHeight
        );

        capturedCssHeight += drawableCssHeight;
      } finally {
        bitmap.close();
      }
    }

    return canvas.convertToBlob(getImageEncodeOptions(format, settings));
  } finally {
    if (pageState) {
      await executeTabFunction(tab.id, restorePageAfterScreenshot, [pageState]).catch(() => {});
    }
  }
}

async function captureScrollableElementScreenshotBlob(tab, pageState, format, settings) {
  let canvas = null;
  let context = null;
  let scaleY = 1;
  let capturedElementContentHeight = 0;

  while (capturedElementContentHeight < pageState.elementScrollHeight) {
    const requestedScrollY = Math.min(capturedElementContentHeight, pageState.maxScrollY);
    const scrollState = await executeTabFunction(tab.id, scrollPageForScreenshot, [pageState, requestedScrollY]);
    const dataUrl = await captureVisibleTabDataUrl(tab);
    const bitmap = await createImageBitmap(await dataUrlToBlob(dataUrl));

    try {
      if (!canvas) {
        const scaleX = bitmap.width / pageState.viewportWidth;
        scaleY = bitmap.height / pageState.viewportHeight;
        const outputWidth = Math.round(pageState.viewportWidth * scaleX);
        const outputHeight = Math.round(pageState.pageHeight * scaleY);

        validateScreenshotSize(outputWidth, outputHeight);
        canvas = new OffscreenCanvas(outputWidth, outputHeight);
        context = canvas.getContext("2d", { alpha: format === "png" });

        if (!context) {
          throw new Error(t("errorCanvasUnavailable"));
        }

        if (format === "jpg") {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, outputWidth, outputHeight);
        }
      }

      if (capturedElementContentHeight === 0) {
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, canvas.width, bitmap.height);
        capturedElementContentHeight = Math.min(pageState.elementViewportHeight, pageState.elementScrollHeight);
        continue;
      }

      const actualScrollY = Number(scrollState?.scrollY) || 0;
      const cropTopInElementCss = Math.max(0, capturedElementContentHeight - actualScrollY);
      const drawableCssHeight = Math.min(
        pageState.elementViewportHeight - cropTopInElementCss,
        pageState.elementScrollHeight - capturedElementContentHeight
      );

      if (drawableCssHeight <= 0) {
        throw new Error(t("errorScreenshotScrollStalled"));
      }

      const sourceY = Math.round((pageState.elementTop + cropTopInElementCss) * scaleY);
      const sourceHeight = Math.min(bitmap.height - sourceY, Math.round(drawableCssHeight * scaleY));
      const targetY = Math.round((pageState.viewportHeight + capturedElementContentHeight - pageState.elementViewportHeight) * scaleY);
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
        targetHeight
      );

      capturedElementContentHeight += drawableCssHeight;
    } finally {
      bitmap.close();
    }
  }

  return canvas.convertToBlob(getImageEncodeOptions(format, settings));
}

function preparePageForScreenshot() {
  const doc = document.documentElement;
  const body = document.body;
  const scrollingElement = document.scrollingElement || doc;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const pageHeight = Math.max(
    scrollingElement.scrollHeight,
    doc.scrollHeight,
    body?.scrollHeight || 0,
    doc.offsetHeight,
    body?.offsetHeight || 0,
    viewportHeight
  );
  const rootMaxScrollY = Math.max(0, pageHeight - viewportHeight);
  const scrollElement = rootMaxScrollY <= 1
    ? findMainScrollElement(viewportWidth, viewportHeight)
    : null;

  if (scrollElement) {
    const rect = scrollElement.getBoundingClientRect();
    const targetId = `img-save-as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const hadTargetMarker = scrollElement.hasAttribute("data-img-save-as-scroll-target");
    const previousTargetMarker = scrollElement.getAttribute("data-img-save-as-scroll-target") || "";
    const elementTop = Math.max(0, Math.min(viewportHeight, rect.top));
    const elementBottom = Math.max(elementTop, Math.min(viewportHeight, rect.bottom));
    const elementViewportHeight = Math.min(scrollElement.clientHeight, Math.max(1, elementBottom - elementTop));

    scrollElement.setAttribute("data-img-save-as-scroll-target", targetId);

    const state = {
      scrollTarget: "element",
      targetId,
      hadTargetMarker,
      previousTargetMarker,
      originalScrollX: window.scrollX,
      originalScrollY: window.scrollY,
      originalTargetScrollTop: scrollElement.scrollTop,
      originalDocumentScrollBehavior: doc.style.scrollBehavior,
      originalBodyScrollBehavior: body?.style.scrollBehavior || "",
      originalTargetScrollBehavior: scrollElement.style.scrollBehavior,
      viewportWidth,
      viewportHeight,
      pageHeight: viewportHeight + Math.max(0, scrollElement.scrollHeight - elementViewportHeight),
      maxScrollY: Math.max(0, scrollElement.scrollHeight - elementViewportHeight),
      elementTop,
      elementViewportHeight,
      elementScrollHeight: scrollElement.scrollHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };

    doc.style.scrollBehavior = "auto";
    if (body) {
      body.style.scrollBehavior = "auto";
    }

    scrollElement.style.scrollBehavior = "auto";
    scrollElement.scrollTop = 0;
    return state;
  }

  const state = {
    scrollTarget: "window",
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
    originalDocumentScrollBehavior: doc.style.scrollBehavior,
    originalBodyScrollBehavior: body?.style.scrollBehavior || "",
    viewportWidth,
    viewportHeight,
    pageHeight,
    maxScrollY: rootMaxScrollY,
    devicePixelRatio: window.devicePixelRatio || 1
  };

  doc.style.scrollBehavior = "auto";
  if (body) {
    body.style.scrollBehavior = "auto";
  }

  window.scrollTo(state.originalScrollX, 0);
  return state;

  function findMainScrollElement(width, height) {
    const elements = Array.from(document.body?.querySelectorAll("*") || []);
    let bestElement = null;
    let bestScore = 0;

    for (const element of elements) {
      const scrollHeight = element.scrollHeight;
      const clientHeight = element.clientHeight;
      if (scrollHeight <= clientHeight + 16 || clientHeight <= 0) {
        continue;
      }

      const style = getComputedStyle(element);
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const visibleWidth = Math.min(width, rect.right) - Math.max(0, rect.left);
      const visibleHeight = Math.min(height, rect.bottom) - Math.max(0, rect.top);
      if (visibleWidth < width * 0.45 || visibleHeight < height * 0.35) {
        continue;
      }

      const score = visibleWidth * visibleHeight * (scrollHeight / clientHeight);
      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }

    return bestElement;
  }
}

function scrollPageForScreenshot(state, scrollY) {
  const target = state.scrollTarget === "element"
    ? document.querySelector(`[data-img-save-as-scroll-target="${state.targetId}"]`)
    : null;

  if (target) {
    target.scrollTop = scrollY;
  } else {
    window.scrollTo(state.originalScrollX, scrollY);
  }

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          resolve({
            scrollX: target ? window.scrollX : window.scrollX,
            scrollY: target ? target.scrollTop : window.scrollY
          });
        }, 80);
      });
    });
  });
}

function restorePageAfterScreenshot(state) {
  const doc = document.documentElement;
  const body = document.body;
  doc.style.scrollBehavior = state.originalDocumentScrollBehavior || "";

  if (body) {
    body.style.scrollBehavior = state.originalBodyScrollBehavior || "";
  }

  if (state.scrollTarget === "element") {
    const target = document.querySelector(`[data-img-save-as-scroll-target="${state.targetId}"]`);
    if (target) {
      target.style.scrollBehavior = state.originalTargetScrollBehavior || "";
      target.scrollTop = state.originalTargetScrollTop || 0;

      if (state.hadTargetMarker) {
        target.setAttribute("data-img-save-as-scroll-target", state.previousTargetMarker || "");
      } else {
        target.removeAttribute("data-img-save-as-scroll-target");
      }
    }
  }

  window.scrollTo(state.originalScrollX || 0, state.originalScrollY || 0);
}

async function executeTabFunction(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  return result?.result;
}

async function captureVisibleTabDataUrl(tab) {
  await ensureTabStillActive(tab);
  await waitForCaptureSlot();
  await ensureTabStillActive(tab);
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function ensureTabStillActive(tab) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId
  });

  if (activeTab?.id !== tab.id) {
    throw new Error(t("errorScreenshotTabChanged"));
  }
}

async function waitForCaptureSlot() {
  const now = Date.now();
  const waitTime = CAPTURE_INTERVAL_MS - (now - lastTabCaptureAt);

  if (waitTime > 0) {
    await wait(waitTime);
  }

  lastTabCaptureAt = Date.now();
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function validateScreenshotSize(width, height) {
  if (!width || !height) {
    throw new Error(t("errorScreenshotEmpty"));
  }

  if (width > MAX_SCREENSHOT_EDGE || height > MAX_SCREENSHOT_EDGE) {
    throw new Error(t("errorScreenshotTooLargeEdge", String(MAX_SCREENSHOT_EDGE)));
  }

  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new Error(t("errorScreenshotTooLargePixels"));
  }
}

function getImageEncodeOptions(format, settings) {
  const options = { type: getMimeType(format) };

  if (format === "jpg") {
    options.quality = settings.jpgQuality;
  }

  if (format === "webp") {
    options.quality = settings.webpQuality;
  }

  return options;
}

function getMimeType(format) {
  if (format === "jpg") {
    return "image/jpeg";
  }

  if (format === "webp") {
    return "image/webp";
  }

  return "image/png";
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function getSourceImageBlob(srcUrl, tabId, frameId) {
  if (!srcUrl) {
    throw new Error(t("errorNoImageUrl"));
  }

  if (isFileUrl(srcUrl)) {
    await ensureFileSchemeAccess(srcUrl);

    if (tabId != null) {
      const fallbackBlob = await extractImageFromPage(tabId, srcUrl, frameId);
      if (fallbackBlob) {
        return fallbackBlob;
      }
    }

    throw new Error(t("errorUnableReadFileImage"));
  }

  if (!srcUrl.startsWith("blob:")) {
    try {
      return await fetchImageBlob(srcUrl);
    } catch (error) {
      if (tabId == null) {
        throw error;
      }
    }
  }

  if (tabId != null) {
    const fallbackBlob = await extractImageFromPage(tabId, srcUrl, frameId);
    if (fallbackBlob) {
      return fallbackBlob;
    }
  }

  throw new Error(t("errorUnableReadImage"));
}

function isFileUrl(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("file:");
}

async function ensureFileSchemeAccess(url) {
  if (!isFileUrl(url)) {
    return;
  }

  const allowed = await isAllowedFileSchemeAccess();
  if (!allowed) {
    throw new Error(t("errorFileUrlAccessRequired"));
  }
}

function isAllowedFileSchemeAccess() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => {
        resolve(Boolean(allowed));
      });
    } catch {
      resolve(true);
    }
  });
}

async function fetchImageBlob(srcUrl) {
  const response = await fetch(srcUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(t("errorImageRequestFailed", String(response.status)));
  }

  return response.blob();
}

async function extractImageFromPage(tabId, srcUrl, frameId) {
  const target =
    typeof frameId === "number" && frameId >= 0
      ? { tabId, frameIds: [frameId] }
      : { tabId };
  const localized = {
    pageFetchFailed: t("errorPageFetchFailed"),
    imageNotLoaded: t("errorImageNotLoaded"),
    canvasUnavailable: t("errorCanvasUnavailable"),
    fileReaderFailed: t("errorFileReaderFailed")
  };

  const [result] = await chrome.scripting.executeScript({
    target,
    func: async (imageUrl, messages) => {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(messages.pageFetchFailed.replace("$STATUS$", String(response.status)));
        }

        const blob = await response.blob();
        return await blobToDataUrl(blob);
      } catch (fetchError) {
        const image = Array.from(document.images).find((candidate) => {
          return candidate.currentSrc === imageUrl || candidate.src === imageUrl;
        });

        if (!image) {
          throw fetchError;
        }

        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) {
          throw new Error(messages.imageNotLoaded);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error(messages.canvasUnavailable);
        }

        context.drawImage(image, 0, 0, width, height);
        return canvas.toDataURL("image/png");
      }

      function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error(messages.fileReaderFailed));
          reader.readAsDataURL(blob);
        });
      }
    },
    args: [srcUrl, localized]
  });

  const dataUrl = result?.result;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return null;
  }

  const response = await fetch(dataUrl);
  return response.blob();
}

async function downloadBlob(blob, filename, silentSave, options = {}) {
  const objectUrl = await createBlobUrl(blob);

  try {
    const primary = await startDownload(objectUrl, filename, !silentSave);
    let downloadId = primary.downloadId;
    let usedSilentFallback = false;

    if (
      downloadId == null &&
      options.retryWithoutSaveDialog &&
      !silentSave &&
      primary.promptLikelyBlocked
    ) {
      const fallback = await startDownload(objectUrl, filename, false);
      downloadId = fallback.downloadId;
      usedSilentFallback = downloadId != null;
    }

    if (downloadId == null) {
      await revokeBlobUrl(objectUrl);
      return null;
    }

    return {
      downloadId,
      objectUrl,
      usedSilentFallback
    };
  } catch (error) {
    await revokeBlobUrl(objectUrl);

    if (chrome.runtime.lastError?.message?.includes("canceled")) {
      return null;
    }

    const message = getErrorMessage(error);
    if (message.toLowerCase().includes("user canceled") || message.toLowerCase().includes("cancelled")) {
      return null;
    }

    throw error;
  }
}

async function startDownload(objectUrl, filename, saveAs) {
  const startedAt = Date.now();

  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs,
      conflictAction: "uniquify"
    });

    return {
      downloadId: downloadId ?? null,
      promptLikelyBlocked: downloadId == null && Date.now() - startedAt <= SAVE_AS_PROMPT_BLOCKED_MS
    };
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    const elapsed = Date.now() - startedAt;

    if (
      saveAs &&
      elapsed <= SAVE_AS_PROMPT_BLOCKED_MS &&
      (message.includes("canceled") ||
        message.includes("cancelled") ||
        message.includes("user activation") ||
        message.includes("file chooser"))
    ) {
      return {
        downloadId: null,
        promptLikelyBlocked: true
      };
    }

    throw error;
  }
}

async function queuePendingDownload(downloadId, payload) {
  const pendingDownloads = await getPendingDownloads();
  pendingDownloads[String(downloadId)] = payload;
  await chrome.storage.session.set({ [PENDING_DOWNLOADS_KEY]: pendingDownloads });
}

async function getPendingDownloads() {
  const sessionData = await chrome.storage.session.get(PENDING_DOWNLOADS_KEY);
  return sessionData[PENDING_DOWNLOADS_KEY] || {};
}

async function clearPendingDownload(downloadId) {
  const pendingDownloads = await getPendingDownloads();
  delete pendingDownloads[String(downloadId)];
  await chrome.storage.session.set({ [PENDING_DOWNLOADS_KEY]: pendingDownloads });
}

async function getDownloadItem(downloadId) {
  const [downloadItem] = await chrome.downloads.search({ id: downloadId });
  return downloadItem;
}

async function processPendingDownload(downloadId) {
  const key = String(downloadId);
  if (processingDownloads.has(key)) {
    return;
  }

  processingDownloads.add(key);

  try {
    const pendingDownloads = await getPendingDownloads();
    const pending = pendingDownloads[key];
    if (!pending) {
      return;
    }

    const downloadItem = await getDownloadItem(downloadId);
    if (downloadItem?.state !== "complete") {
      return;
    }

    await revokePendingObjectUrl(pending);
    await clearPendingDownload(downloadId);

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

    const savedTitle = pending.captureType === "screenshot"
      ? t("notifyScreenshotSavedTitle")
      : t("notifyImageSavedTitle");
    const savedMessage = pending.captureType === "screenshot"
      ? t("notifyScreenshotSavedMessage", labelForFormat(pending.format))
      : t("notifyImageSavedMessage", labelForFormat(pending.format));

    if (pending.action === "copy-path" && copiedPath) {
      await notify(
        t("notifySavedAndCopiedTitle"),
        t("notifySavedAndCopiedMessage", labelForFormat(pending.format)),
        "success"
      );
    } else if (pending.action === "copy-path" && errorMessage) {
      await notify(
        savedTitle,
        t("notifySavedCopyFailedMessage", [labelForFormat(pending.format), errorMessage]),
        "error"
      );
    } else {
      await notify(savedTitle, savedMessage, "success");
    }

    await appendSaveHistory({
      status: "completed",
      action: pending.action,
      format: pending.format,
      pageTitle: pending.pageTitle,
      srcUrl: pending.srcUrl,
      requestedPath: pending.requestedPath,
      finalPath,
      copiedPath,
      error: errorMessage,
      captureType: pending.captureType || "image",
      screenshotMode: pending.screenshotMode || "",
      createdAt: pending.createdAt,
      finishedAt: new Date().toISOString()
    });
  } finally {
    processingDownloads.delete(key);
  }
}

async function processInterruptedDownload(downloadId) {
  const pendingDownloads = await getPendingDownloads();
  const pending = pendingDownloads[String(downloadId)];
  if (!pending) {
    return;
  }

  await revokePendingObjectUrl(pending);
  await clearPendingDownload(downloadId);

  await appendSaveHistory({
    status: "interrupted",
    action: pending.action,
    format: pending.format,
    pageTitle: pending.pageTitle,
    srcUrl: pending.srcUrl,
    requestedPath: pending.requestedPath,
    finalPath: "",
    copiedPath: false,
    error: t("errorDownloadInterrupted"),
    captureType: pending.captureType || "image",
    screenshotMode: pending.screenshotMode || "",
    createdAt: pending.createdAt,
    finishedAt: new Date().toISOString()
  });

  await notify(t("notifySaveFailedTitle"), t("notifyInterruptedMessage"), "error");
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
  return FORMATS.find((item) => item.id === format)?.title || format.toUpperCase();
}

async function notify(title, message, status = "success") {
  await chrome.action.setBadgeBackgroundColor({
    color: status === "error" ? "#b42318" : "#1d6f42"
  });
  await chrome.action.setBadgeText({
    text: status === "error" ? "ERR" : "OK"
  });
  await chrome.action.setTitle({
    title: `${title}\n${message}`
  });

  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" });
  }, 8000);

  await appendActivity({
    title,
    message,
    status,
    createdAt: new Date().toISOString()
  });
}

function getErrorMessage(error) {
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
  activeLocale = translator.locale;
  translate = translator.t;

  await chrome.action.setTitle({
    title: t("extActionTitle")
  });
}

async function appendActivity(entry) {
  const stored = await chrome.storage.local.get(RECENT_ACTIVITY_KEY);
  const current = Array.isArray(stored[RECENT_ACTIVITY_KEY]) ? stored[RECENT_ACTIVITY_KEY] : [];
  const next = [entry, ...current].slice(0, 12);

  await chrome.storage.local.set({
    [RECENT_ACTIVITY_KEY]: next
  });
}

async function appendSaveHistory(entry) {
  const stored = await chrome.storage.local.get(SAVE_HISTORY_KEY);
  const current = Array.isArray(stored[SAVE_HISTORY_KEY]) ? stored[SAVE_HISTORY_KEY] : [];
  const next = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...entry
    },
    ...current
  ].slice(0, 200);

  await chrome.storage.local.set({
    [SAVE_HISTORY_KEY]: next
  });
}
