const blobUrls = new Set();
const blobUploads = new Map();
const blobUrlReaperTimeouts = new Map();
const BLOB_URL_REAP_CHECK_DELAY_MS = 5 * 60 * 1000;
const BLOB_URL_REAP_RETRY_MS = 30 * 60 * 1000;
const OFFSCREEN_MESSAGE_TYPES = new Set([
  "WRITE_TEXT",
  "BEGIN_BLOB_URL",
  "APPEND_BLOB_URL_CHUNK",
  "COMMIT_BLOB_URL",
  "ABORT_BLOB_URL",
  "REVOKE_BLOB_URL"
]);
let activeOperations = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_OFFSCREEN_STATUS") {
    sendResponse({
      ok: true,
      activeOperations,
      blobUrlCount: blobUrls.size
    });
    return false;
  }

  if (!OFFSCREEN_MESSAGE_TYPES.has(message?.type)) {
    return false;
  }

  activeOperations += 1;
  void respondToMessage(message, sendResponse);
  return true;
});

async function respondToMessage(message, sendResponse) {
  let response;

  try {
    response = await handleMessage(message);
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : "Clipboard write failed."
    };
  } finally {
    activeOperations -= 1;
  }

  sendResponse(response);
}

async function handleMessage(message) {
  if (message?.type === "WRITE_TEXT") {
    await writeText(message.text || "");
    return { ok: true };
  }

  if (message?.type === "BEGIN_BLOB_URL") {
    if (
      typeof message.uploadId !== "string" ||
      !message.uploadId ||
      blobUploads.has(message.uploadId) ||
      !Number.isSafeInteger(message.expectedSize) ||
      message.expectedSize < 0
    ) {
      throw new Error("Invalid blob upload.");
    }

    blobUploads.set(message.uploadId, {
      mimeType:
        typeof message.mimeType === "string"
          ? message.mimeType
          : "application/octet-stream",
      expectedSize: message.expectedSize,
      receivedSize: 0,
      chunks: []
    });
    return { ok: true };
  }

  if (message?.type === "APPEND_BLOB_URL_CHUNK") {
    const upload = getBlobUpload(message.uploadId);
    const chunk = decodeBase64(message.base64);
    if (upload.receivedSize + chunk.byteLength > upload.expectedSize) {
      throw new Error("Blob upload exceeds its declared size.");
    }

    upload.chunks.push(chunk);
    upload.receivedSize += chunk.byteLength;
    return { ok: true };
  }

  if (message?.type === "COMMIT_BLOB_URL") {
    const upload = getBlobUpload(message.uploadId);
    if (upload.receivedSize !== upload.expectedSize) {
      throw new Error("Blob upload is incomplete.");
    }

    const blob = new Blob(upload.chunks, { type: upload.mimeType });
    const url = URL.createObjectURL(blob);
    trackBlobUrl(url);
    blobUploads.delete(message.uploadId);
    return { ok: true, url };
  }

  if (message?.type === "ABORT_BLOB_URL") {
    if (typeof message.uploadId === "string") {
      blobUploads.delete(message.uploadId);
    }

    return { ok: true };
  }

  if (message?.type === "REVOKE_BLOB_URL") {
    revokeTrackedBlobUrl(message.url);

    return { ok: true };
  }

  return { ok: false, error: "Unknown offscreen message." };
}

function trackBlobUrl(url) {
  blobUrls.add(url);
  scheduleBlobUrlReapCheck(url, BLOB_URL_REAP_CHECK_DELAY_MS);
}

function scheduleBlobUrlReapCheck(url, delay) {
  if (!blobUrls.has(url)) {
    return;
  }

  const timeoutId = setTimeout(() => {
    blobUrlReaperTimeouts.delete(url);
    void requestBlobUrlReap(url);
  }, delay);
  blobUrlReaperTimeouts.set(url, timeoutId);
}

async function requestBlobUrlReap(url) {
  if (!blobUrls.has(url)) {
    return;
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "CAN_REAP_BLOB_URL",
      url,
    });
  } catch {
    response = null;
  }

  if (!response?.ok || !response.reap) {
    scheduleBlobUrlReapCheck(url, BLOB_URL_REAP_RETRY_MS);
    return;
  }

  revokeTrackedBlobUrl(url);
  await chrome.runtime
    .sendMessage({ type: "BLOB_URL_REAPED", url })
    .catch(() => {});
}

function revokeTrackedBlobUrl(url) {
  if (!url || !blobUrls.has(url)) {
    return;
  }

  const timeoutId = blobUrlReaperTimeouts.get(url);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
    blobUrlReaperTimeouts.delete(url);
  }
  URL.revokeObjectURL(url);
  blobUrls.delete(url);
}

function getBlobUpload(uploadId) {
  const upload =
    typeof uploadId === "string" ? blobUploads.get(uploadId) : undefined;
  if (!upload) {
    throw new Error("Blob upload was not initialized.");
  }

  return upload;
}

function decodeBase64(base64) {
  if (typeof base64 !== "string") {
    throw new Error("Invalid blob upload chunk.");
  }

  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("Invalid blob upload chunk.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function writeText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.inset = "0";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand("copy");
    textarea.remove();

    if (!copied) {
      throw new Error("Text copy was blocked by the browser.");
    }
  }
}
