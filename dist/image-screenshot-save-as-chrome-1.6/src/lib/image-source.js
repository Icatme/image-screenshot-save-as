import {
	MAX_IMAGE_EDGE,
	MAX_IMAGE_PIXELS,
	MAX_SOURCE_IMAGE_BYTES,
} from "./image-convert.js";

const IMAGE_FETCH_TIMEOUT_MS = 25_000;

export async function readDataUrlBlob(dataUrl, t) {
	const response = await fetch(dataUrl);
	return readResponseBlobWithLimit(response, MAX_SOURCE_IMAGE_BYTES, t);
}

export async function getSourceImageBlob(srcUrl, tabId, frameId, t) {
	if (!srcUrl) {
		throw new Error(t("errorNoImageUrl"));
	}

	if (isFileUrl(srcUrl)) {
		await ensureFileSchemeAccess(srcUrl, t);

		if (tabId != null) {
			const fallbackBlob = await extractImageFromPage(
				tabId,
				srcUrl,
				frameId,
				t,
			);
			if (fallbackBlob) {
				return fallbackBlob;
			}
		}

		throw new Error(t("errorUnableReadFileImage"));
	}

	if (!srcUrl.startsWith("blob:")) {
		try {
			return await fetchImageBlob(srcUrl, t);
		} catch (error) {
			if (tabId == null) {
				throw error;
			}
		}
	}

	if (tabId != null) {
		const fallbackBlob = await extractImageFromPage(tabId, srcUrl, frameId, t);
		if (fallbackBlob) {
			return fallbackBlob;
		}
	}

	throw new Error(t("errorUnableReadImage"));
}

export async function ensureFileSchemeAccess(url, t) {
	if (!isFileUrl(url)) {
		return;
	}

	const allowed = await isAllowedFileSchemeAccess();
	if (!allowed) {
		throw new Error(t("errorFileUrlAccessRequired"));
	}
}

function isFileUrl(value) {
	return typeof value === "string" && value.toLowerCase().startsWith("file:");
}

function isAllowedFileSchemeAccess() {
	if (typeof chrome.extension?.isAllowedFileSchemeAccess !== "function") {
		return Promise.resolve(false);
	}

	return new Promise((resolve) => {
		try {
			chrome.extension.isAllowedFileSchemeAccess((allowed) => {
				resolve(Boolean(allowed));
			});
		} catch {
			resolve(false);
		}
	});
}

async function fetchImageBlob(srcUrl, t) {
	// Credentials remain scoped by Chrome to the requested origin. Including
	// them preserves user-triggered saves from authenticated image hosts.
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(srcUrl, {
			credentials: "include",
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(t("errorImageRequestFailed", String(response.status)));
		}

		return await readResponseBlobWithLimit(
			response,
			MAX_SOURCE_IMAGE_BYTES,
			t,
		);
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(t("errorImageRequestTimedOut"));
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function extractImageFromPage(tabId, srcUrl, frameId, t) {
	const target =
		typeof frameId === "number" && frameId >= 0
			? { tabId, frameIds: [frameId] }
			: { tabId };
	const localized = {
		pageFetchFailed: t("errorPageFetchFailed"),
		imageNotLoaded: t("errorImageNotLoaded"),
		canvasUnavailable: t("errorCanvasUnavailable"),
		fileReaderFailed: t("errorFileReaderFailed"),
		sourceTooLarge: t("errorSourceImageTooLarge"),
		requestTimedOut: t("errorImageRequestTimedOut"),
		imageTooLarge: t("errorImageDimensionsTooLarge"),
	};

	const [result] = await chrome.scripting.executeScript({
		target,
		func: async (
			imageUrl,
			messages,
			maxSourceBytes,
			requestTimeoutMs,
			maxImageEdge,
			maxImagePixels,
		) => {
			try {
				const controller = new AbortController();
				const timeoutId = window.setTimeout(
					() => controller.abort(),
					requestTimeoutMs,
				);
				let blob;
				try {
					const response = await fetch(imageUrl, { signal: controller.signal });
					if (!response.ok) {
						throw new Error(
							messages.pageFetchFailed.replace(
								"$STATUS$",
								String(response.status),
							),
						);
					}

					blob = await responseToBlobWithLimit(response, maxSourceBytes);
				} catch (error) {
					if (controller.signal.aborted) {
						throw new Error(messages.requestTimedOut);
					}
					throw error;
				} finally {
					window.clearTimeout(timeoutId);
				}
				return await blobToDataUrl(blob);
			} catch (fetchError) {
				if (fetchError?.name === "SourceImageTooLargeError") {
					throw fetchError;
				}
				const image = Array.from(document.images).find((candidate) => {
					return (
						candidate.currentSrc === imageUrl || candidate.src === imageUrl
					);
				});

				if (!image) {
					throw fetchError;
				}

				const width = image.naturalWidth || image.width;
				const height = image.naturalHeight || image.height;
				if (!width || !height) {
					throw new Error(messages.imageNotLoaded);
				}
				if (
					width > maxImageEdge ||
					height > maxImageEdge ||
					width * height > maxImagePixels
				) {
					throw new Error(messages.imageTooLarge);
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

			async function responseToBlobWithLimit(response, maxBytes) {
				const declaredSize = Number(response.headers.get("content-length"));
				if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
					throw sourceTooLargeError();
				}

				if (!response.body) {
					const blob = await response.blob();
					if (blob.size > maxBytes) {
						throw sourceTooLargeError();
					}
					return blob;
				}

				const reader = response.body.getReader();
				const chunks = [];
				let received = 0;
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					received += value.byteLength;
					if (received > maxBytes) {
						await reader.cancel();
						throw sourceTooLargeError();
					}
					chunks.push(value);
				}
				return new Blob(chunks, {
					type: response.headers.get("content-type") || "",
				});
			}

			function sourceTooLargeError() {
				const error = new Error(messages.sourceTooLarge);
				error.name = "SourceImageTooLargeError";
				return error;
			}
		},
		args: [
			srcUrl,
			localized,
			MAX_SOURCE_IMAGE_BYTES,
			IMAGE_FETCH_TIMEOUT_MS,
			MAX_IMAGE_EDGE,
			MAX_IMAGE_PIXELS,
		],
	});

	const dataUrl = result?.result;
	if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
		return null;
	}

	return readDataUrlBlob(dataUrl, t);
}

async function readResponseBlobWithLimit(response, maxBytes, t) {
	const declaredSize = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
		throw new Error(t("errorSourceImageTooLarge"));
	}

	if (!response.body) {
		const blob = await response.blob();
		if (blob.size > maxBytes) {
			throw new Error(t("errorSourceImageTooLarge"));
		}
		return blob;
	}

	const reader = response.body.getReader();
	const chunks = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel();
			throw new Error(t("errorSourceImageTooLarge"));
		}
		chunks.push(value);
	}

	return new Blob(chunks, {
		type: response.headers.get("content-type") || "",
	});
}
