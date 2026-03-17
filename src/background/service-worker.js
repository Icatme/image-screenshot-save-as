import { copyTextToClipboard, createBlobUrl, revokeBlobUrl } from "../lib/clipboard.js";
import { buildDownloadPath } from "../lib/file-name.js";
import { getTranslator } from "../lib/i18n.js";
import { convertImageBlob } from "../lib/image-convert.js";
import { getSettings } from "../lib/settings.js";

const ROOT_MENU_ID = "img-save-as";
const PENDING_DOWNLOADS_KEY = "pendingDownloads";
const RECENT_ACTIVITY_KEY = "recentActivity";
const SAVE_HISTORY_KEY = "saveHistory";
const processingDownloads = new Set();
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
}

async function handleMenuClick(info, tab) {
  const command = parseMenuId(info.menuItemId);
  if (!command) {
    return;
  }

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

function parseMenuId(menuItemId) {
  if (typeof menuItemId !== "string") {
    return null;
  }

  const parts = menuItemId.split(":");
  if (parts.length !== 3 || parts[0] !== "action") {
    return null;
  }

  return {
    format: parts[1],
    action: parts[2]
  };
}

async function getSourceImageBlob(srcUrl, tabId, frameId) {
  if (!srcUrl) {
    throw new Error(t("errorNoImageUrl"));
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

async function downloadBlob(blob, filename, silentSave) {
  const objectUrl = await createBlobUrl(blob);

  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: !silentSave,
      conflictAction: "uniquify"
    });

    if (downloadId == null) {
      await revokeBlobUrl(objectUrl);
      return null;
    }

    return {
      downloadId,
      objectUrl
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

    if (pending.action === "copy-path" && copiedPath) {
      await notify(
        t("notifySavedAndCopiedTitle"),
        t("notifySavedAndCopiedMessage", labelForFormat(pending.format)),
        "success"
      );
    } else if (pending.action === "copy-path" && errorMessage) {
      await notify(
        t("notifyImageSavedTitle"),
        t("notifySavedCopyFailedMessage", [labelForFormat(pending.format), errorMessage]),
        "error"
      );
    } else {
      await notify(t("notifyImageSavedTitle"), t("notifyImageSavedMessage", labelForFormat(pending.format)), "success");
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
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icons/icon-128.png"),
      title,
      message
    });
  } catch {
    // Notifications may be suppressed by Chrome or the OS.
  }

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
