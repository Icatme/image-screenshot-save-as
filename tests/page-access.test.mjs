import assert from "node:assert/strict";
import test from "node:test";

import { isExtensionGalleryUrl } from "../src/lib/page-access.js";

test("current and legacy Chrome Web Store URLs are extension galleries", () => {
	assert.equal(
		isExtensionGalleryUrl("https://chromewebstore.google.com/detail/example/id"),
		true,
	);
	assert.equal(
		isExtensionGalleryUrl("https://chrome.google.com/webstore/detail/example/id"),
		true,
	);
});

test("ordinary Google and web pages are not extension galleries", () => {
	assert.equal(isExtensionGalleryUrl("https://chrome.google.com/"), false);
	assert.equal(isExtensionGalleryUrl("https://example.com/webstore/"), false);
	assert.equal(isExtensionGalleryUrl("not a URL"), false);
});
