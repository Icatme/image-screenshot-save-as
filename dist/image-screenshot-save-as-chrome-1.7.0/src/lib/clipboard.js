const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";
// Chrome extension messages are capped at 64 MiB. Keep every base64 payload
// near 4 MiB so large exports never depend on a single oversized message.
const BLOB_TRANSFER_CHUNK_BYTES = 3 * 1024 * 1024;
let offscreenCreationPromise = null;
let offscreenClosePromise = null;
let activeOperations = 0;
let activityVersion = 0;

export async function copyTextToClipboard(text) {
	return withOffscreenDocument(() => {
		return sendOffscreenMessage({
			type: "WRITE_TEXT",
			text,
		});
	});
}

async function ensureOffscreenDocument() {
	if (offscreenClosePromise) {
		await offscreenClosePromise.catch(() => {});
	}

	const contexts = await getOffscreenContexts();

	if (contexts.length > 0) {
		return;
	}

	if (!offscreenCreationPromise) {
		offscreenCreationPromise = chrome.offscreen
			.createDocument({
				url: OFFSCREEN_DOCUMENT_PATH,
				reasons: ["CLIPBOARD", "BLOBS"],
				justification:
					"Write text to the clipboard and manage blob URLs for local image export.",
			})
			.catch(async (error) => {
				let currentContexts;
				try {
					currentContexts = await getOffscreenContexts();
				} catch {
					throw error;
				}

				if (currentContexts.length === 0) {
					throw error;
				}
			})
			.finally(() => {
				offscreenCreationPromise = null;
			});
	}

	await offscreenCreationPromise;
}

async function sendOffscreenMessage(message) {
	const response = await chrome.runtime.sendMessage(message);
	if (!response?.ok) {
		throw new Error(response?.error || "Clipboard operation failed.");
	}

	return response;
}

export async function createBlobUrl(blob) {
	return withOffscreenDocument(async () => {
		const uploadId = crypto.randomUUID();
		let committed = false;

		try {
			await sendOffscreenMessage({
				type: "BEGIN_BLOB_URL",
				uploadId,
				mimeType: blob.type || "application/octet-stream",
				expectedSize: blob.size,
			});

			for (
				let offset = 0;
				offset < blob.size;
				offset += BLOB_TRANSFER_CHUNK_BYTES
			) {
				await sendOffscreenMessage({
					type: "APPEND_BLOB_URL_CHUNK",
					uploadId,
					base64: await blobSliceToBase64(
						blob.slice(offset, offset + BLOB_TRANSFER_CHUNK_BYTES),
					),
				});
			}

			const response = await sendOffscreenMessage({
				type: "COMMIT_BLOB_URL",
				uploadId,
			});
			committed = true;
			return response.url;
		} finally {
			if (!committed) {
				await sendOffscreenMessage({
					type: "ABORT_BLOB_URL",
					uploadId,
				}).catch(() => {});
			}
		}
	});
}

export async function revokeBlobUrl(url) {
	if (!url) {
		return;
	}

	await withOffscreenDocument(() => {
		return sendOffscreenMessage({
			type: "REVOKE_BLOB_URL",
			url,
		});
	});
}

async function withOffscreenDocument(operation) {
	activeOperations += 1;
	activityVersion += 1;

	try {
		await ensureOffscreenDocument();
		return await operation();
	} finally {
		activeOperations -= 1;
		activityVersion += 1;

		try {
			await closeOffscreenDocumentIfIdle();
		} catch {
			// Cleanup failure must not replace the result of the requested operation.
		}
	}
}

async function closeOffscreenDocumentIfIdle() {
	if (
		activeOperations !== 0 ||
		offscreenCreationPromise ||
		offscreenClosePromise
	) {
		return;
	}

	const checkedVersion = activityVersion;
	const contexts = await getOffscreenContexts();
	if (contexts.length === 0) {
		return;
	}

	const status = await sendOffscreenMessage({ type: "GET_OFFSCREEN_STATUS" });
	if (
		activeOperations !== 0 ||
		activityVersion !== checkedVersion ||
		status.activeOperations !== 0 ||
		status.blobUrlCount !== 0
	) {
		return;
	}

	offscreenClosePromise = chrome.offscreen.closeDocument().finally(() => {
		offscreenClosePromise = null;
	});
	await offscreenClosePromise;
}

async function getOffscreenContexts() {
	const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
	return chrome.runtime.getContexts({
		contextTypes: ["OFFSCREEN_DOCUMENT"],
		documentUrls: [offscreenUrl],
	});
}

async function blobSliceToBase64(blobSlice) {
	const bytes = new Uint8Array(await blobSlice.arrayBuffer());
	let binary = "";

	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}

	return btoa(binary);
}

// A previous service-worker instance may have left an idle document behind.
if (typeof chrome !== "undefined") {
	void closeOffscreenDocumentIfIdle().catch(() => {});
}
