import assert from "node:assert/strict";
import test from "node:test";

test("the offscreen document ignores messages owned by the service worker", async () => {
	let listener;
	globalThis.chrome = {
		runtime: {
			onMessage: {
				addListener(nextListener) {
					listener = nextListener;
				},
			},
		},
	};

	try {
		await import(`../src/offscreen/offscreen.js?test=${crypto.randomUUID()}`);
		const responses = [];
		const keepsChannelOpen = listener(
			{ type: "CLEAR_SAVE_HISTORY" },
			{},
			(response) => responses.push(response),
		);

		assert.equal(keepsChannelOpen, false);
		assert.deepEqual(responses, []);
	} finally {
		delete globalThis.chrome;
	}
});

test("the offscreen document assembles chunked blob URL uploads", async () => {
	let listener;
	globalThis.chrome = {
		runtime: {
			onMessage: {
				addListener(nextListener) {
					listener = nextListener;
				},
			},
		},
	};

	const dispatch = (message) =>
		new Promise((resolve, reject) => {
			try {
				assert.equal(listener(message, {}, resolve), true);
			} catch (error) {
				reject(error);
			}
		});

	try {
		await import(`../src/offscreen/offscreen.js?test=${crypto.randomUUID()}`);
		const uploadId = crypto.randomUUID();
		assert.deepEqual(
			await dispatch({
				type: "BEGIN_BLOB_URL",
				uploadId,
				mimeType: "text/plain",
				expectedSize: 5,
			}),
			{ ok: true },
		);
		assert.deepEqual(
			await dispatch({
				type: "APPEND_BLOB_URL_CHUNK",
				uploadId,
				base64: "YWJj",
			}),
			{ ok: true },
		);
		assert.deepEqual(
			await dispatch({
				type: "APPEND_BLOB_URL_CHUNK",
				uploadId,
				base64: "ZGU=",
			}),
			{ ok: true },
		);

		const committed = await dispatch({
			type: "COMMIT_BLOB_URL",
			uploadId,
		});
		assert.equal(committed.ok, true);
		const blob = await (await fetch(committed.url)).blob();
		assert.equal(blob.type, "text/plain");
		assert.equal(await blob.text(), "abcde");
		assert.deepEqual(
			await dispatch({ type: "REVOKE_BLOB_URL", url: committed.url }),
			{ ok: true },
		);
	} finally {
		delete globalThis.chrome;
	}
});
