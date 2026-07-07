chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message, sendResponse);
  return true;
});

const blobUrls = new Set();

async function handleMessage(message, sendResponse) {
  try {
    if (message?.type === "WRITE_TEXT") {
      await writeText(message.text || "");
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "WRITE_IMAGE") {
      const response = await fetch(message.imageUrl);
      const blob = await response.blob();
      await writeImage(blob, message.imageUrl, message.mimeType || blob.type || "image/png");
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "CREATE_BLOB_URL") {
      const response = await fetch(message.dataUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      blobUrls.add(url);
      sendResponse({ ok: true, url });
      return;
    }

    if (message?.type === "REVOKE_BLOB_URL") {
      if (message.url && blobUrls.has(message.url)) {
        URL.revokeObjectURL(message.url);
        blobUrls.delete(message.url);
      }

      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown offscreen message." });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Clipboard write failed."
    });
  }
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

async function writeImage(blob, imageUrl, mimeType) {
  await navigator.clipboard.write([
    new ClipboardItem({
      [mimeType]: blob
    })
  ]);

  if (navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    const hasImage = items.some((item) => {
      return item.types.includes(mimeType) || item.types.includes("image/png") || item.types.some((type) => type.startsWith("image/"));
    });

    if (!hasImage) {
      throw new Error("Clipboard verification failed after image write.");
    }
  }
}
