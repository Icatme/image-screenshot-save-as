import assert from "node:assert/strict";
import test from "node:test";

function createStorageArea(initial = {}, hooks = {}) {
	const state = { ...initial };

	return {
		state,
		async get(keys) {
			if (keys == null) {
				return { ...state };
			}
			if (typeof keys === "string") {
				return Object.hasOwn(state, keys) ? { [keys]: state[keys] } : {};
			}

			const result = { ...keys };
			for (const key of Object.keys(keys)) {
				if (Object.hasOwn(state, key)) {
					result[key] = state[key];
				}
			}
			return result;
		},
		async set(values) {
			Object.assign(state, values);
			hooks.onSet?.(values);
		},
		async remove(keys) {
			const normalizedKeys = Array.isArray(keys) ? keys : [keys];
			for (const key of normalizedKeys) {
				delete state[key];
			}
			hooks.onRemove?.(normalizedKeys);
		},
		async setAccessLevel() {},
	};
}

async function waitUntil(predicate, message, timeoutMilliseconds = 2_000) {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withPendingRecoveryHarness(
	{
		session = {},
		downloadItems = {},
		handleOffscreenMessage = async () => ({ ok: true }),
		captureConsoleErrors = false,
	},
	assertScenario,
) {
	let downloadChangedListener;
	let downloadSearchCalls = 0;
	let runtimeMessageListener;
	const notifications = [];
	const sessionEvents = [];
	const localArea = createStorageArea();
	const sessionArea = createStorageArea(session, {
		onSet(values) {
			sessionEvents.push({ type: "set", values: structuredClone(values) });
		},
		onRemove(keys) {
			sessionEvents.push({ type: "remove", keys: [...keys] });
		},
	});
	const catalog = {
		extActionTitle: { message: "save image" },
		notifyPartialScreenshotSavedTitle: { message: "partial saved" },
		notifyPartialScreenshotSavedMessage: {
			message: "partial $FORMAT$",
			placeholders: { format: { content: "$1" } },
		},
		notifyPartialScreenshotSavedAndCopiedMessage: {
			message: "partial $FORMAT$ copied",
			placeholders: { format: { content: "$1" } },
		},
		notifyPartialScreenshotSavedCopyFailedMessage: {
			message: "partial $FORMAT$ copy failed: $ERROR$",
			placeholders: {
				format: { content: "$1" },
				error: { content: "$2" },
			},
		},
	};
	const originalSetTimeout = globalThis.setTimeout;
	const originalConsoleError = console.error;
	const loggedErrors = [];
	if (captureConsoleErrors) {
		console.error = (...args) => {
			loggedErrors.push(args);
		};
	}
	globalThis.setTimeout = (callback, delay, ...args) => {
		if (delay === 8000) {
			return 0;
		}
		return originalSetTimeout(callback, delay, ...args);
	};

	globalThis.chrome = {
		runtime: {
			onInstalled: { addListener() {} },
			onStartup: { addListener() {} },
			onMessage: {
				addListener(listener) {
					runtimeMessageListener = listener;
				},
			},
			getURL(resource) {
				return resource.startsWith("_locales/")
					? `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`
					: `chrome-extension://test/${resource}`;
			},
			async getContexts() {
				return [];
			},
			async sendMessage(message) {
				return handleOffscreenMessage(message);
			},
		},
		i18n: {
			getUILanguage: () => "en",
			getMessage: (key) => key,
		},
		contextMenus: {
			onClicked: { addListener() {} },
		},
		downloads: {
			onChanged: {
				addListener(listener) {
					downloadChangedListener = listener;
				},
			},
			async search({ id }) {
				downloadSearchCalls += 1;
				return Object.hasOwn(downloadItems, id) ? [downloadItems[id]] : [];
			},
		},
		storage: {
			local: localArea,
			session: sessionArea,
			sync: createStorageArea({ localeOverride: "auto" }),
			onChanged: { addListener() {} },
		},
		action: {
			onClicked: { addListener() {} },
			async setTitle() {},
			async setBadgeText() {},
			async setBadgeBackgroundColor() {},
		},
		notifications: {
			async create(id, options) {
				notifications.push({ id, options });
				return id;
			},
		},
		offscreen: {
			async createDocument() {},
			async closeDocument() {},
		},
	};

	try {
		await import(
			`../src/background/service-worker.js?pending-recovery=${crypto.randomUUID()}`
		);
		await assertScenario({
			downloadChangedListener,
			getDownloadSearchCalls: () => downloadSearchCalls,
			localArea,
			loggedErrors,
			notifications,
			runtimeMessageListener,
			sessionArea,
			sessionEvents,
		});
	} finally {
		console.error = originalConsoleError;
		globalThis.setTimeout = originalSetTimeout;
		delete globalThis.chrome;
	}
}

test("restricted Chrome Web Store actions stop before script injection", async () => {
	let menuClickListener;
	let executeScriptCalls = 0;
	let resolveNotifications;
	let resolveFeedbackScheduled;
	const createdNotifications = [];
	const notificationsCreated = new Promise((resolve) => {
		resolveNotifications = resolve;
	});
	const feedbackScheduled = new Promise((resolve) => {
		resolveFeedbackScheduled = resolve;
	});
	const catalog = {
		errorExtensionGalleryRestricted: { message: "localized gallery restriction" },
		errorScreenshotScriptRestricted: {
			message: "localized screenshot restriction",
		},
		notifySaveFailedTitle: { message: "save failed" },
		extActionTitle: { message: "save image" },
	};
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (callback, delay, ...args) => {
		if (delay === 8000) {
			resolveFeedbackScheduled();
			return 0;
		}
		return originalSetTimeout(callback, delay, ...args);
	};

	globalThis.chrome = {
		runtime: {
			onInstalled: { addListener() {} },
			onStartup: { addListener() {} },
			onMessage: { addListener() {} },
			getURL(resource) {
				if (resource.startsWith("_locales/")) {
					return `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`;
				}
				return `chrome-extension://test/${resource}`;
			},
			async getContexts() {
				return [];
			},
			async sendMessage() {
				return { ok: true };
			},
		},
		i18n: {
			getUILanguage: () => "en",
			getMessage: (key) => key,
		},
		contextMenus: {
			onClicked: {
				addListener(listener) {
					menuClickListener = listener;
				},
			},
		},
		downloads: {
			onChanged: { addListener() {} },
			async search() {
				return [];
			},
		},
		storage: {
			local: createStorageArea(),
			session: createStorageArea(),
			sync: createStorageArea({ localeOverride: "auto" }),
			onChanged: { addListener() {} },
		},
		action: {
			onClicked: { addListener() {} },
			async setTitle() {},
			async setBadgeText() {},
			async setBadgeBackgroundColor() {},
		},
		notifications: {
			async create(id, options) {
				createdNotifications.push({ id, options });
				if (createdNotifications.length === 2) {
					resolveNotifications([...createdNotifications]);
				}
				return id;
			},
		},
		scripting: {
			async executeScript() {
				executeScriptCalls += 1;
				throw new Error("The extensions gallery cannot be scripted.");
			},
		},
		offscreen: {
			async createDocument() {},
			async closeDocument() {},
		},
	};

	try {
		await import(
			`../src/background/service-worker.js?gallery-handler=${crypto.randomUUID()}`
		);
		menuClickListener(
			{
				menuItemId: "action:png:save",
				srcUrl: "blob:https://chromewebstore.google.com/image",
				pageUrl:
					"https://chromewebstore.google.com/detail/example/extension-id",
				frameId: 0,
			},
			{
				id: 7,
				windowId: 3,
				title: "Chrome Web Store",
			},
		);
		menuClickListener(
			{
				menuItemId: "screenshot:region:png:save",
				pageUrl:
					"https://chromewebstore.google.com/detail/example/extension-id",
			},
			{
				id: 7,
				windowId: 3,
				title: "Chrome Web Store",
				url: "https://chromewebstore.google.com/detail/example/extension-id",
			},
		);

		const notifications = await notificationsCreated;
		await feedbackScheduled;
		await Promise.resolve();
		assert.equal(executeScriptCalls, 0);
		assert.deepEqual(
			notifications.map(({ options }) => options.message).sort(),
			["localized gallery restriction", "localized screenshot restriction"],
		);
		for (const notification of notifications) {
			assert.equal(
				notification.options.iconUrl,
				"chrome-extension://test/assets/icons/icon-128.png",
			);
		}
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		delete globalThis.chrome;
	}
});

test(
	"region screenshot handler crops the captured bitmap before download",
	{ timeout: 5_000 },
	async () => {
		let menuClickListener;
		let downloadStarted = false;
		let resolveHandled;
		const handled = new Promise((resolve) => {
			resolveHandled = resolve;
		});
		const drawCalls = [];
		const canvasCalls = [];
		const downloadCalls = [];
		let bitmapClosed = false;
		const tab = {
			id: 17,
			windowId: 4,
			title: "Dashboard",
			url: "https://example.test/dashboard",
		};
		const sessionStorage = createStorageArea({}, {
			onRemove(keys) {
				if (downloadStarted && keys.includes("activeScreenshot")) {
					resolveHandled();
				}
			},
		});
		const originalCreateImageBitmap = globalThis.createImageBitmap;
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;

		globalThis.createImageBitmap = async () => ({
			width: 200,
			height: 100,
			close() {
				bitmapClosed = true;
			},
		});
		globalThis.OffscreenCanvas = class {
			constructor(width, height) {
				this.width = width;
				this.height = height;
				canvasCalls.push({ width, height });
			}

			getContext(type, options) {
				assert.equal(type, "2d");
				assert.deepEqual(options, { alpha: true });
				return {
					drawImage(...args) {
						drawCalls.push(args);
					},
				};
			}

			async convertToBlob(options) {
				assert.deepEqual(options, { type: "image/png" });
				return new Blob(["cropped"], { type: options.type });
			}
		};

		globalThis.chrome = {
			runtime: {
				onInstalled: { addListener() {} },
				onStartup: { addListener() {} },
				onMessage: { addListener() {} },
				getURL(resource) {
					return resource.startsWith("_locales/")
						? `data:application/json,${encodeURIComponent("{}")}`
						: `chrome-extension://test/${resource}`;
				},
				async getContexts() {
					return [{}];
				},
				async sendMessage(message) {
					if (message.type === "COMMIT_BLOB_URL") {
						return { ok: true, url: "blob:test-region" };
					}
					if (message.type === "GET_OFFSCREEN_STATUS") {
						return { ok: true, activeOperations: 0, blobUrlCount: 1 };
					}
					return { ok: true };
				},
			},
			i18n: {
				getUILanguage: () => "en",
				getMessage: (key) => key,
			},
			contextMenus: {
				onClicked: {
					addListener(listener) {
						menuClickListener = listener;
					},
				},
			},
			downloads: {
				onChanged: { addListener() {} },
				async download(options) {
					downloadCalls.push(options);
					downloadStarted = true;
					return 29;
				},
				async search() {
					return [{ id: 29, state: "in_progress" }];
				},
				async cancel() {},
			},
			storage: {
				local: createStorageArea(),
				session: sessionStorage,
				sync: createStorageArea({ localeOverride: "auto" }),
				onChanged: { addListener() {} },
			},
			action: {
				onClicked: { addListener() {} },
				async setTitle() {},
				async setBadgeText() {},
				async setBadgeBackgroundColor() {},
			},
			notifications: {
				async create(id) {
					return id;
				},
			},
			scripting: {
				async executeScript(options) {
					assert.equal(options.func.name, "selectScreenshotRegion");
					return [
						{
							result: {
								cancelled: false,
								x: 10,
								y: 5,
								width: 50,
								height: 25,
								viewportWidth: 100,
								viewportHeight: 50,
							},
						},
					];
				},
			},
			tabs: {
				async query() {
					return [tab];
				},
				async captureVisibleTab(windowId, options) {
					assert.equal(windowId, tab.windowId);
					assert.deepEqual(options, { format: "png" });
					return "data:image/png;base64,AA==";
				},
				async get() {
					return tab;
				},
			},
			offscreen: {
				async createDocument() {},
				async closeDocument() {},
			},
		};

		try {
			await import(
				`../src/background/service-worker.js?region-handler=${crypto.randomUUID()}`
			);
			menuClickListener(
				{
					menuItemId: "screenshot:region:png:save",
					pageUrl: tab.url,
				},
				tab,
			);
			await handled;

			assert.deepEqual(canvasCalls, [{ width: 100, height: 50 }]);
			assert.equal(drawCalls.length, 1);
			assert.deepEqual(drawCalls[0].slice(1), [
				20,
				10,
				100,
				50,
				0,
				0,
				100,
				50,
			]);
			assert.equal(bitmapClosed, true);
			assert.deepEqual(downloadCalls, [
				{
					url: "blob:test-region",
					filename: "Dashboard-selected-area-screenshot.png",
					saveAs: true,
					conflictAction: "uniquify",
				},
			]);
		} finally {
			if (originalCreateImageBitmap === undefined) {
				delete globalThis.createImageBitmap;
			} else {
				globalThis.createImageBitmap = originalCreateImageBitmap;
			}
			if (originalOffscreenCanvas === undefined) {
				delete globalThis.OffscreenCanvas;
			} else {
				globalThis.OffscreenCanvas = originalOffscreenCanvas;
			}
			delete globalThis.chrome;
		}
	},
);

test(
	"full-page screenshot saves captured canvas when scrolling stalls",
	{ timeout: 5_000 },
	async () => {
		let menuClickListener;
		let resolveHandled;
		let downloadStarted = false;
		let captureCalls = 0;
		let scrollCalls = 0;
		let savedHistory = null;
		let recentActivity = null;
		const handled = new Promise((resolve) => {
			resolveHandled = resolve;
		});
		const drawCalls = [];
		const canvasCalls = [];
		const encodedCanvasCalls = [];
		const downloadCalls = [];
		const notifications = [];
		const tab = {
			id: 27,
			windowId: 5,
			title: "Long page",
			url: "https://example.test/long-page",
		};
		const catalog = {
			extActionTitle: { message: "save image" },
			errorScreenshotScrollStalled: { message: "scroll stalled" },
			notifyPartialScreenshotSavedTitle: { message: "partial saved" },
			notifyPartialScreenshotSavedMessage: {
				message: "partial $FORMAT$",
				placeholders: { format: { content: "$1" } },
			},
		};
		const sessionStorage = createStorageArea({}, {
			onRemove(keys) {
				if (downloadStarted && keys.includes("activeScreenshot")) {
					resolveHandled();
				}
			},
		});
		const localStorage = createStorageArea({}, {
			onSet(values) {
				if (Array.isArray(values.saveHistory)) {
					savedHistory = values.saveHistory;
				}
				if (Array.isArray(values.recentActivity)) {
					recentActivity = values.recentActivity;
				}
			},
		});
		const originalCreateImageBitmap = globalThis.createImageBitmap;
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		const originalSetTimeout = globalThis.setTimeout;

		globalThis.setTimeout = (callback, delay, ...args) => {
			if (delay === 8000) {
				return 0;
			}
			return originalSetTimeout(callback, delay, ...args);
		};
		globalThis.createImageBitmap = async () => ({
			width: 100,
			height: 50,
			close() {},
		});
		globalThis.OffscreenCanvas = class {
			constructor(width, height) {
				this.width = width;
				this.height = height;
				canvasCalls.push({ width, height });
			}

			getContext(type, options) {
				assert.equal(type, "2d");
				assert.deepEqual(options, { alpha: true });
				return {
					drawImage(...args) {
						drawCalls.push(args);
					},
				};
			}

			async convertToBlob(options) {
				assert.deepEqual(options, { type: "image/png" });
				encodedCanvasCalls.push({ width: this.width, height: this.height });
				return new Blob(["partial"], { type: options.type });
			}
		};

		globalThis.chrome = {
			runtime: {
				onInstalled: { addListener() {} },
				onStartup: { addListener() {} },
				onMessage: { addListener() {} },
				getURL(resource) {
					return resource.startsWith("_locales/")
						? `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`
						: `chrome-extension://test/${resource}`;
				},
				async getContexts() {
					return [{}];
				},
				async sendMessage(message) {
					if (message.type === "COMMIT_BLOB_URL") {
						return { ok: true, url: "blob:test-partial" };
					}
					if (message.type === "GET_OFFSCREEN_STATUS") {
						return { ok: true, activeOperations: 0, blobUrlCount: 1 };
					}
					return { ok: true };
				},
			},
			i18n: {
				getUILanguage: () => "en",
				getMessage: (key) => key,
			},
			contextMenus: {
				onClicked: {
					addListener(listener) {
						menuClickListener = listener;
					},
				},
			},
			downloads: {
				onChanged: { addListener() {} },
				async download(options) {
					downloadCalls.push(options);
					downloadStarted = true;
					return 41;
				},
				async search() {
					return [
						{
							id: 41,
							state: "complete",
							filename: "C:\\Downloads\\Long-page-full-page-screenshot.png",
						},
					];
				},
				async cancel() {},
			},
			storage: {
				local: localStorage,
				session: sessionStorage,
				sync: createStorageArea({ localeOverride: "es" }),
				onChanged: { addListener() {} },
			},
			action: {
				onClicked: { addListener() {} },
				async setTitle() {},
				async setBadgeText() {},
				async setBadgeBackgroundColor() {},
			},
			notifications: {
				async create(id, options) {
					notifications.push({ id, options });
					return id;
				},
			},
			scripting: {
				async executeScript(options) {
					switch (options.func.name) {
						case "preparePageForScreenshot":
							return [
								{
									documentId: "document-1",
									result: {
										recoveryToken: "capture-1",
										scrollTarget: "window",
										originalScrollX: 0,
										originalScrollY: 0,
										viewportWidth: 100,
										viewportHeight: 50,
										pageHeight: 120,
										maxScrollY: 70,
										devicePixelRatio: 1,
									},
								},
							];
						case "scrollPageForScreenshot":
							scrollCalls += 1;
							return [
								{ result: { scrollY: scrollCalls === 1 ? 0 : 50 } },
							];
						case "isPagePreparedForScreenshot":
						case "restorePageAfterScreenshot":
							return [{ result: true }];
						default:
							throw new Error(`Unexpected script: ${options.func.name}`);
					}
				},
			},
			tabs: {
				async query() {
					return [tab];
				},
				async captureVisibleTab(windowId, options) {
					assert.equal(windowId, tab.windowId);
					assert.deepEqual(options, { format: "png" });
					captureCalls += 1;
					return "data:image/png;base64,AA==";
				},
				async get() {
					return tab;
				},
			},
			offscreen: {
				async createDocument() {},
				async closeDocument() {},
			},
		};

		try {
			await import(
				`../src/background/service-worker.js?partial-handler=${crypto.randomUUID()}`
			);
			menuClickListener(
				{
					menuItemId: "screenshot:full-page:png:save",
					pageUrl: tab.url,
				},
				tab,
			);
			await handled;

			assert.equal(captureCalls, 3);
			assert.equal(scrollCalls, 3);
			assert.deepEqual(canvasCalls, [
				{ width: 100, height: 120 },
				{ width: 100, height: 100 },
			]);
			assert.deepEqual(encodedCanvasCalls, [{ width: 100, height: 100 }]);
			assert.ok(drawCalls.length >= 3);
			assert.deepEqual(downloadCalls, [
				{
					url: "blob:test-partial",
					filename: "Long-page-full-page-screenshot-partial.png",
					saveAs: true,
					conflictAction: "uniquify",
				},
			]);
			assert.equal(savedHistory?.[0]?.partialCapture, true);
			assert.equal(savedHistory?.[0]?.partialReason, "scroll_stalled");
			assert.equal(savedHistory?.[0]?.capturedHeight, 100);
			assert.equal(savedHistory?.[0]?.totalHeight, 120);
			assert.equal(recentActivity?.[0]?.status, "warning");
			assert.equal(notifications.at(-1)?.options.title, "partial saved");
			assert.equal(notifications.at(-1)?.options.message, "partial PNG");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			if (originalCreateImageBitmap === undefined) {
				delete globalThis.createImageBitmap;
			} else {
				globalThis.createImageBitmap = originalCreateImageBitmap;
			}
			if (originalOffscreenCanvas === undefined) {
				delete globalThis.OffscreenCanvas;
			} else {
				globalThis.OffscreenCanvas = originalOffscreenCanvas;
			}
			delete globalThis.chrome;
		}
	},
);

test(
	"first full-page frame failure does not start a download",
	{ timeout: 5_000 },
	async () => {
		let menuClickListener;
		let downloadCalls = 0;
		const notifications = [];
		let resolveHandled;
		const handled = new Promise((resolve) => {
			resolveHandled = resolve;
		});
		const tab = {
			id: 37,
			windowId: 6,
			title: "Broken page",
			url: "https://example.test/broken-page",
		};
		let screenshotLeaseStored = false;
		const sessionStorage = createStorageArea({}, {
			onSet(values) {
				if (values.activeScreenshot) {
					screenshotLeaseStored = true;
				}
			},
			onRemove(keys) {
				if (screenshotLeaseStored && keys.includes("activeScreenshot")) {
					resolveHandled();
				}
			},
		});
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = (callback, delay, ...args) => {
			if (delay === 8000) {
				return 0;
			}
			return originalSetTimeout(callback, delay, ...args);
		};
		globalThis.chrome = {
			runtime: {
				onInstalled: { addListener() {} },
				onStartup: { addListener() {} },
				onMessage: { addListener() {} },
				getURL(resource) {
					return resource.startsWith("_locales/")
						? `data:application/json,${encodeURIComponent(JSON.stringify({
								extActionTitle: { message: "save image" },
								notifySaveFailedTitle: { message: "save failed" },
							}))}`
						: `chrome-extension://test/${resource}`;
				},
				async getContexts() {
					return [];
				},
				async sendMessage() {
					return { ok: true };
				},
			},
			i18n: {
				getUILanguage: () => "en",
				getMessage: (key) => key,
			},
			contextMenus: {
				onClicked: {
					addListener(listener) {
						menuClickListener = listener;
					},
				},
			},
			downloads: {
				onChanged: { addListener() {} },
				async download() {
					downloadCalls += 1;
					return 51;
				},
				async search() {
					return [];
				},
			},
			storage: {
				local: createStorageArea(),
				session: sessionStorage,
				sync: createStorageArea({ localeOverride: "auto" }),
				onChanged: { addListener() {} },
			},
			action: {
				onClicked: { addListener() {} },
				async setTitle() {},
				async setBadgeText() {},
				async setBadgeBackgroundColor() {},
			},
			notifications: {
				async create(id, options) {
					notifications.push({ id, options });
					return id;
				},
			},
			scripting: {
				async executeScript(options) {
					switch (options.func.name) {
						case "preparePageForScreenshot":
							return [
								{
									documentId: "document-first-frame",
									result: {
										recoveryToken: "capture-first-frame",
										scrollTarget: "window",
										originalScrollX: 0,
										originalScrollY: 0,
										viewportWidth: 100,
										viewportHeight: 50,
										pageHeight: 120,
										maxScrollY: 70,
										devicePixelRatio: 1,
									},
								},
							];
						case "scrollPageForScreenshot":
							return [{ result: { scrollY: 0 } }];
						case "restorePageAfterScreenshot":
							return [{ result: true }];
						default:
							throw new Error(`Unexpected script: ${options.func.name}`);
					}
				},
			},
			tabs: {
				async query() {
					return [tab];
				},
				async captureVisibleTab() {
					throw new Error("first frame failed");
				},
				async get() {
					return tab;
				},
			},
			offscreen: {
				async createDocument() {},
				async closeDocument() {},
			},
		};

		try {
			await import(
				`../src/background/service-worker.js?first-frame=${crypto.randomUUID()}`
			);
			menuClickListener(
				{
					menuItemId: "screenshot:full-page:png:save",
					pageUrl: tab.url,
				},
				tab,
			);
			await handled;

			assert.equal(downloadCalls, 0);
			assert.equal(notifications.at(-1)?.options.title, "save failed");
			assert.equal(notifications.at(-1)?.options.message, "first frame failed");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			delete globalThis.chrome;
		}
	},
);

test("partial copy-path feedback distinguishes warning from copy failure", async (t) => {
	for (const scenario of [
		{ name: "copied", copyFails: false, expectedStatus: "warning" },
		{ name: "copy failed", copyFails: true, expectedStatus: "error" },
	]) {
		await t.test(scenario.name, async () => {
			const downloadId = scenario.copyFails ? 62 : 61;
			const pendingKey = `pendingDownload:${downloadId}`;
			await withPendingRecoveryHarness(
				{
					session: {
						[pendingKey]: {
							historyId: `partial-copy-${downloadId}`,
							action: "copy-path",
							captureType: "screenshot",
							screenshotMode: "full-page",
							partialCapture: true,
							partialReason: "scroll_stalled",
							capturedHeight: 100,
							totalHeight: 120,
							format: "png",
							requestedPath: "page-full-page-screenshot-partial.png",
							objectUrl: `blob:partial-${downloadId}`,
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					},
					downloadItems: {
						[downloadId]: {
							id: downloadId,
							state: "complete",
							filename: `C:\\Downloads\\partial-${downloadId}.png`,
						},
					},
					handleOffscreenMessage: async (message) => {
						if (message.type === "WRITE_TEXT" && scenario.copyFails) {
							return { ok: false, error: "copy denied" };
						}
						return { ok: true };
					},
				},
				async ({ localArea, sessionArea }) => {
					await waitUntil(
						() => !Object.hasOwn(sessionArea.state, pendingKey),
						`Pending copy-path download ${downloadId} was not finalized.`,
					);
					assert.equal(
						localArea.state.recentActivity?.[0]?.status,
						scenario.expectedStatus,
					);
					assert.equal(
						localArea.state.saveHistory?.[0]?.copiedPath,
						!scenario.copyFails,
					);
					assert.equal(
						localArea.state.saveHistory?.[0]?.partialReason,
						"scroll_stalled",
					);
				},
			);
		});
	}
});

test("failed Blob URL cleanup is retained as cleanup-only work and retried", async () => {
	const downloadId = 71;
	const pendingKey = `pendingDownload:${downloadId}`;
	let revokeCalls = 0;

	await withPendingRecoveryHarness(
		{
			session: {
				[pendingKey]: {
					historyId: "cleanup-retry",
					action: "save",
					captureType: "screenshot",
					screenshotMode: "full-page",
					partialCapture: true,
					partialReason: "capture_failed",
					capturedHeight: 80,
					totalHeight: 120,
					format: "png",
					requestedPath: "page-full-page-screenshot-partial.png",
					objectUrl: "blob:cleanup-retry",
					createdAt: "2026-08-23T00:00:00.000Z",
				},
			},
			downloadItems: {
				[downloadId]: {
					id: downloadId,
					state: "complete",
					filename: "C:\\Downloads\\partial.png",
				},
			},
			handleOffscreenMessage: async (message) => {
				if (message.type === "REVOKE_BLOB_URL") {
					revokeCalls += 1;
					return revokeCalls === 1
						? { ok: false, error: "offscreen unavailable" }
						: { ok: true };
				}
				return { ok: true };
			},
			captureConsoleErrors: true,
		},
		async ({
			downloadChangedListener,
			localArea,
			loggedErrors,
			sessionArea,
			sessionEvents,
		}) => {
			await waitUntil(
				() => sessionArea.state[pendingKey]?.cleanupOnly === true,
				"Failed cleanup was not retained as cleanup-only pending work.",
			);
			assert.ok(
				sessionEvents.some(
					(event) =>
						event.type === "set" && event.values[pendingKey]?.cleanupOnly === true,
				),
			);

			downloadChangedListener({
				id: downloadId,
				state: { current: "complete" },
			});
			await waitUntil(
				() => !Object.hasOwn(sessionArea.state, pendingKey),
				"Cleanup-only pending work was not removed after a successful retry.",
			);

			assert.equal(revokeCalls, 2);
			assert.equal(localArea.state.saveHistory?.length, 1);
			assert.equal(localArea.state.recentActivity?.length, 1);
			assert.ok(
				loggedErrors.some(([message]) =>
					String(message).includes("Failed to revoke a pending download blob URL"),
				),
			);
		},
	);
});

test("an offscreen self-reap drains matching cleanup-only work", async () => {
	const downloadId = 72;
	const pendingKey = `pendingDownload:${downloadId}`;
	const objectUrl = "blob:self-reaped";

	await withPendingRecoveryHarness(
		{
			session: {
				[pendingKey]: {
					cleanupOnly: true,
					objectUrl,
				},
			},
			handleOffscreenMessage: async (message) => {
				if (message.type === "REVOKE_BLOB_URL") {
					return { ok: false, error: "offscreen unavailable" };
				}
				return { ok: true };
			},
			captureConsoleErrors: true,
		},
		async ({ localArea, runtimeMessageListener, sessionArea }) => {
			await waitUntil(
				() => sessionArea.state[pendingKey]?.cleanupOnly === true,
				"Cleanup-only work was not retained before owner reaping.",
			);
			const authorization = await new Promise((resolve) => {
				assert.equal(
					runtimeMessageListener(
						{ type: "CAN_REAP_BLOB_URL", url: objectUrl },
						{},
						resolve,
					),
					true,
				);
			});
			assert.deepEqual(authorization, { ok: true, reap: true });
			const response = await new Promise((resolve) => {
				assert.equal(
					runtimeMessageListener(
						{ type: "BLOB_URL_REAPED", url: objectUrl },
						{},
						resolve,
					),
					true,
				);
			});
			assert.deepEqual(response, { ok: true });
			assert.equal(Object.hasOwn(sessionArea.state, pendingKey), false);
			assert.equal(localArea.state.saveHistory, undefined);
			assert.equal(localArea.state.recentActivity, undefined);
		},
	);
});

test("the worker denies owner reaping while a download is still active", async () => {
	const downloadId = 73;
	const pendingKey = `pendingDownload:${downloadId}`;
	const objectUrl = "blob:active-download";

	await withPendingRecoveryHarness(
		{
			session: {
				[pendingKey]: {
					cleanupOnly: false,
					objectUrl,
				},
			},
			downloadItems: {
				[downloadId]: { id: downloadId, state: "in_progress" },
			},
		},
		async ({ getDownloadSearchCalls, runtimeMessageListener, sessionArea }) => {
			await waitUntil(
				() => getDownloadSearchCalls() > 0,
				"Runtime recovery did not inspect the active download.",
			);
			const authorization = await new Promise((resolve) => {
				assert.equal(
					runtimeMessageListener(
						{ type: "CAN_REAP_BLOB_URL", url: objectUrl },
						{},
						resolve,
					),
					true,
				);
			});
			assert.deepEqual(authorization, { ok: true, reap: false });
			assert.equal(sessionArea.state[pendingKey]?.cleanupOnly, false);
		},
	);
});

test("one malformed pending download does not block recovery of later records", async () => {
	const malformedKey = "pendingDownload:81";
	const validKey = "pendingDownload:82";

	await withPendingRecoveryHarness(
		{
			session: {
				[malformedKey]: "not-an-object",
				[validKey]: {
					historyId: "valid-recovery",
					action: "save",
					format: "png",
					requestedPath: "valid.png",
					objectUrl: "blob:valid-recovery",
					createdAt: "2026-08-23T00:00:00.000Z",
				},
			},
			downloadItems: {
				82: {
					id: 82,
					state: "complete",
					filename: "C:\\Downloads\\valid.png",
				},
			},
		},
		async ({ localArea, sessionArea }) => {
			await waitUntil(
				() =>
					!Object.hasOwn(sessionArea.state, malformedKey) &&
					!Object.hasOwn(sessionArea.state, validKey),
				"Pending recovery did not isolate and drain malformed work.",
			);
			assert.equal(localArea.state.saveHistory?.[0]?.id, "valid-recovery");
		},
	);
});
