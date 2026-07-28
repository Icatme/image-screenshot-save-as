import assert from "node:assert/strict";
import test from "node:test";

async function loadClipboardModule() {
	const previousChrome = globalThis.chrome;
	delete globalThis.chrome;
	try {
		return await import(`../src/lib/clipboard.js?test=${crypto.randomUUID()}`);
	} finally {
		if (previousChrome === undefined) {
			delete globalThis.chrome;
		} else {
			globalThis.chrome = previousChrome;
		}
	}
}

function installChromeMock(handleMessage) {
	globalThis.chrome = {
		runtime: {
			getURL(path) {
				return `chrome-extension://test/${path}`;
			},
			async getContexts() {
				return [{}];
			},
			sendMessage: handleMessage,
		},
		offscreen: {
			async createDocument() {},
			async closeDocument() {},
		},
	};
}

test("large blobs are transferred to the offscreen document in bounded messages", async () => {
	const { createBlobUrl } = await loadClipboardModule();
	const messages = [];
	installChromeMock(async (message) => {
		messages.push(message);
		if (message.type === "COMMIT_BLOB_URL") {
			return { ok: true, url: "blob:test-large" };
		}
		if (message.type === "GET_OFFSCREEN_STATUS") {
			return { ok: true, activeOperations: 0, blobUrlCount: 1 };
		}
		return { ok: true };
	});

	try {
		const byteLength = 6 * 1024 * 1024 + 7;
		const blob = new Blob([new Uint8Array(byteLength)], {
			type: "image/png",
		});
		assert.equal(await createBlobUrl(blob), "blob:test-large");

		const begin = messages.find((message) => message.type === "BEGIN_BLOB_URL");
		const chunks = messages.filter(
			(message) => message.type === "APPEND_BLOB_URL_CHUNK",
		);
		assert.equal(begin.expectedSize, byteLength);
		assert.equal(begin.mimeType, "image/png");
		assert.equal(chunks.length, 3);
		assert.equal(
			chunks.reduce(
				(total, message) => total + Buffer.from(message.base64, "base64").length,
				0,
			),
			byteLength,
		);
		assert.ok(
			chunks.every((message) => message.base64.length <= 4 * 1024 * 1024),
		);
		assert.ok(messages.every((message) => !("dataUrl" in message)));
	} finally {
		delete globalThis.chrome;
	}
});

test("a failed blob transfer is explicitly aborted", async () => {
	const { createBlobUrl } = await loadClipboardModule();
	const messageTypes = [];
	installChromeMock(async (message) => {
		messageTypes.push(message.type);
		if (message.type === "APPEND_BLOB_URL_CHUNK") {
			return { ok: false, error: "simulated transfer failure" };
		}
		if (message.type === "GET_OFFSCREEN_STATUS") {
			return { ok: true, activeOperations: 0, blobUrlCount: 0 };
		}
		return { ok: true };
	});

	try {
		await assert.rejects(
			createBlobUrl(new Blob([new Uint8Array(4)], { type: "image/png" })),
			/simulated transfer failure/,
		);
		assert.ok(messageTypes.includes("ABORT_BLOB_URL"));
		assert.ok(!messageTypes.includes("COMMIT_BLOB_URL"));
	} finally {
		delete globalThis.chrome;
	}
});
