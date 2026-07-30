import assert from "node:assert/strict";
import test from "node:test";

function createStorageArea(initial = {}, hooks = {}) {
	const state = { ...initial };

	return {
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
