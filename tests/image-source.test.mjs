import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SOURCE_IMAGE_BYTES } from "../src/lib/image-convert.js";
import {
	ensureFileSchemeAccess,
	getSourceImageBlob,
	readDataUrlBlob,
} from "../src/lib/image-source.js";

const originalFetch = globalThis.fetch;
const translate = (key) => key;

test.afterEach(() => {
	globalThis.fetch = originalFetch;
	delete globalThis.chrome;
});

test("data URL reads reject a declared source larger than the safety limit", async () => {
	globalThis.fetch = async () => ({
		headers: new Headers({
			"content-length": String(MAX_SOURCE_IMAGE_BYTES + 1),
		}),
		body: null,
	});

	await assert.rejects(
		readDataUrlBlob("data:image/png;base64,AA==", translate),
		/errorSourceImageTooLarge/,
	);
});

test("file URL access fails closed when Chrome cannot verify the toggle", async () => {
	globalThis.chrome = { extension: {} };

	await assert.rejects(
		ensureFileSchemeAccess("file:///private/image.png", translate),
		/errorFileUrlAccessRequired/,
	);
});

test("file URL access succeeds only after Chrome explicitly allows it", async () => {
	globalThis.chrome = {
		extension: {
			isAllowedFileSchemeAccess(callback) {
				callback(true);
			},
		},
	};

	await ensureFileSchemeAccess("file:///allowed/image.png", translate);
});

test("Chrome Web Store image fallback fails before forbidden script injection", async () => {
	let executeScriptCalled = false;
	globalThis.chrome = {
		scripting: {
			async executeScript() {
				executeScriptCalled = true;
				throw new Error("The extensions gallery cannot be scripted.");
			},
		},
	};

	await assert.rejects(
		getSourceImageBlob(
			"blob:https://chromewebstore.google.com/example",
			7,
			0,
			"https://chromewebstore.google.com/detail/example/id",
			translate,
		),
		/errorExtensionGalleryRestricted/,
	);
	assert.equal(executeScriptCalled, false);
});
