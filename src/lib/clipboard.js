const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";
let offscreenPromise = null;

export async function copyTextToClipboard(text) {
	await ensureOffscreenDocument();
	return sendOffscreenMessage({
		type: "WRITE_TEXT",
		text,
	});
}

export async function copyImageBlob(blob, mimeType) {
	await ensureOffscreenDocument();

	const imageUrl = await createBlobUrl(blob);
	try {
		return await sendOffscreenMessage({
			type: "WRITE_IMAGE",
			imageUrl,
			mimeType,
		});
	} finally {
		setTimeout(() => {
			void revokeBlobUrl(imageUrl);
		}, 10_000);
	}
}

async function ensureOffscreenDocument() {
	const contexts = await getOffscreenContexts();

	if (contexts.length > 0) {
		return;
	}

	if (!offscreenPromise) {
		offscreenPromise = chrome.offscreen
			.createDocument({
				url: OFFSCREEN_DOCUMENT_PATH,
				reasons: ["CLIPBOARD", "BLOBS"],
				justification:
					"Write clipboard data and manage blob URLs for local image export.",
			})
			.catch((error) => {
				// Ignore "already exists" errors from concurrent creation attempts.
				// This can happen when multiple clipboard operations race.
				if (!error?.message?.includes("already exists")) {
					throw error;
				}
			})
			.finally(() => {
				offscreenPromise = null;
			});
	}

	await offscreenPromise;
}

async function sendOffscreenMessage(message) {
	const response = await chrome.runtime.sendMessage(message);
	if (!response?.ok) {
		throw new Error(response?.error || "Clipboard operation failed.");
	}

	return response;
}

export async function createBlobUrl(blob) {
	await ensureOffscreenDocument();

	const dataUrl = await blobToDataUrl(blob);
	const response = await sendOffscreenMessage({
		type: "CREATE_BLOB_URL",
		dataUrl,
	});

	return response.url;
}

export async function revokeBlobUrl(url) {
	if (!url) {
		return;
	}

	await ensureOffscreenDocument();
	await sendOffscreenMessage({
		type: "REVOKE_BLOB_URL",
		url,
	});
}

async function getOffscreenContexts() {
	const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

	if ("getContexts" in chrome.runtime) {
		return chrome.runtime.getContexts({
			contextTypes: ["OFFSCREEN_DOCUMENT"],
			documentUrls: [offscreenUrl],
		});
	}

	const matchedClients = await clients.matchAll();
	return matchedClients.filter((client) => client.url === offscreenUrl);
}

function blobToDataUrl(blob) {
	return blob.arrayBuffer().then((buffer) => {
		const bytes = new Uint8Array(buffer);
		let binary = "";
		const chunkSize = 0x8000;

		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			const chunk = bytes.subarray(offset, offset + chunkSize);
			binary += String.fromCharCode(...chunk);
		}

		return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
	});
}
