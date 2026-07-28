import assert from "node:assert/strict";
import test from "node:test";

function createStorageArea(initial = {}) {
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
		},
		async remove(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				delete state[key];
			}
		},
		async setAccessLevel() {},
	};
}

test("image menu rejects Chrome Web Store before script injection", async () => {
	let menuClickListener;
	let executeScriptCalls = 0;
	let resolveNotification;
	let resolveFeedbackScheduled;
	const notificationCreated = new Promise((resolve) => {
		resolveNotification = resolve;
	});
	const feedbackScheduled = new Promise((resolve) => {
		resolveFeedbackScheduled = resolve;
	});
	const catalog = {
		errorExtensionGalleryRestricted: { message: "localized gallery restriction" },
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
				resolveNotification({ id, options });
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

		const notification = await notificationCreated;
		await feedbackScheduled;
		await Promise.resolve();
		assert.equal(executeScriptCalls, 0);
		assert.equal(notification.options.message, "localized gallery restriction");
		assert.equal(
			notification.options.iconUrl,
			"chrome-extension://test/assets/icons/icon-128.png",
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		delete globalThis.chrome;
	}
});
