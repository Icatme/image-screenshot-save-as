const PENDING_DOWNLOAD_PREFIX = "pendingDownload:";
const SAVE_HISTORY_KEY = "saveHistory";
const RECENT_ACTIVITY_KEY = "recentActivity";
const SAVE_HISTORY_LIMIT = 200;
const RECENT_ACTIVITY_LIMIT = 12;

const pendingMutationQueues = new Map();
const localMutationQueues = new Map();

export async function setPendingDownload(downloadId, payload) {
	const key = pendingDownloadKey(downloadId);
	return enqueueMutation(pendingMutationQueues, key, () => {
		return chrome.storage.session.set({ [key]: payload });
	});
}

export async function getPendingDownload(downloadId) {
	const key = pendingDownloadKey(downloadId);
	await waitForQueuedMutation(pendingMutationQueues, key);
	const stored = await chrome.storage.session.get(key);
	return stored[key] || null;
}

export async function deletePendingDownload(downloadId) {
	const key = pendingDownloadKey(downloadId);
	return enqueueMutation(pendingMutationQueues, key, () => {
		return chrome.storage.session.remove(key);
	});
}

export async function listPendingDownloads() {
	await Promise.allSettled([...pendingMutationQueues.values()]);
	const stored = await chrome.storage.session.get(null);
	return Object.entries(stored)
		.filter(([key]) => key.startsWith(PENDING_DOWNLOAD_PREFIX))
		.map(([key, value]) => ({
			downloadId: Number(key.slice(PENDING_DOWNLOAD_PREFIX.length)),
			payload: value,
		}))
		.filter((entry) => Number.isInteger(entry.downloadId) && entry.downloadId >= 0);
}

export function appendActivity(entry) {
	return mutateLocalList(RECENT_ACTIVITY_KEY, RECENT_ACTIVITY_LIMIT, (current) => {
		const normalized = {
			id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			...entry,
		};
		return [
			normalized,
			...current.filter((item) => item?.id !== normalized.id),
		];
	});
}

export function appendSaveHistory(entry) {
	return mutateLocalList(SAVE_HISTORY_KEY, SAVE_HISTORY_LIMIT, (current) => {
		const normalized = sanitizeHistoryEntry({
			id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			...entry,
		});
		return [
			normalized,
			...current.filter((item) => item?.id !== normalized.id),
		];
	});
}

export function clearSaveHistory() {
	return enqueueMutation(localMutationQueues, SAVE_HISTORY_KEY, () => {
		return chrome.storage.local.remove(SAVE_HISTORY_KEY);
	});
}

export function sanitizeSaveHistory() {
	return mutateLocalList(SAVE_HISTORY_KEY, SAVE_HISTORY_LIMIT, (current) => {
		return current.map(sanitizeHistoryEntry);
	});
}

async function mutateLocalList(key, limit, transform) {
	return enqueueMutation(localMutationQueues, key, async () => {
		const stored = await chrome.storage.local.get(key);
		const current = Array.isArray(stored[key]) ? stored[key] : [];
		const next = transform(current).slice(0, limit);
		await chrome.storage.local.set({ [key]: next });
		return next;
	});
}

function sanitizeHistoryEntry(entry) {
	const partialCapture = Boolean(entry?.partialCapture);
	const totalHeight = normalizeDimension(entry?.totalHeight);
	const capturedHeight = Math.min(
		normalizeDimension(entry?.capturedHeight),
		totalHeight || Number.MAX_SAFE_INTEGER,
	);

	return {
		id: String(entry?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
		status: entry?.status === "interrupted" ? "interrupted" : "completed",
		action: entry?.action === "copy-path" ? "copy-path" : "save",
		format: normalizeString(entry?.format),
		requestedPath: normalizeString(entry?.requestedPath),
		finalPath: normalizeString(entry?.finalPath),
		copiedPath: Boolean(entry?.copiedPath),
		error: normalizeString(entry?.error),
		captureType: entry?.captureType === "screenshot" ? "screenshot" : "image",
		screenshotMode: normalizeString(entry?.screenshotMode),
		partialCapture,
		partialReason: partialCapture
			? normalizePartialReason(entry?.partialReason)
			: "",
		capturedHeight: partialCapture ? capturedHeight : 0,
		totalHeight: partialCapture ? totalHeight : 0,
		createdAt: normalizeString(entry?.createdAt),
		finishedAt: normalizeString(entry?.finishedAt),
	};
}

function pendingDownloadKey(downloadId) {
	return `${PENDING_DOWNLOAD_PREFIX}${String(downloadId)}`;
}

function normalizeString(value) {
	return typeof value === "string" ? value : "";
}

function normalizeDimension(value) {
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizePartialReason(value) {
	return ["scroll_stalled", "tab_changed", "capture_failed"].includes(value)
		? value
		: "";
}

async function waitForQueuedMutation(queue, key) {
	const pending = queue.get(key);
	if (pending) {
		await pending.catch(() => {});
	}
}

function enqueueMutation(queue, key, operation) {
	const previous = queue.get(key) || Promise.resolve();
	const current = previous.catch(() => {}).then(operation);
	const tracked = current.finally(() => {
		if (queue.get(key) === tracked) {
			queue.delete(key);
		}
	});
	queue.set(key, tracked);
	return tracked;
}
