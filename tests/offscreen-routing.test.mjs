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

test("the offscreen document reaps only worker-authorized blob URLs", async () => {
	let listener;
	let allowReap = false;
	const scheduledReapers = [];
	const runtimeMessages = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = (callback, delay) => {
		scheduledReapers.push({ callback, delay });
		return 90 + scheduledReapers.length;
	};
	globalThis.clearTimeout = () => {};
	globalThis.chrome = {
		runtime: {
			onMessage: {
				addListener(nextListener) {
					listener = nextListener;
				},
			},
			async sendMessage(message) {
				runtimeMessages.push(message);
				if (message.type === "CAN_REAP_BLOB_URL") {
					return { ok: true, reap: allowReap };
				}
				return { ok: true };
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
		await dispatch({
			type: "BEGIN_BLOB_URL",
			uploadId,
			mimeType: "application/octet-stream",
			expectedSize: 0,
		});
		const committed = await dispatch({ type: "COMMIT_BLOB_URL", uploadId });
		assert.equal(committed.ok, true);
		assert.equal(scheduledReapers[0].delay, 5 * 60 * 1000);

		scheduledReapers.shift().callback();
		await new Promise((resolve) => originalSetTimeout(resolve, 0));

		let activeStatus;
		assert.equal(
			listener({ type: "GET_OFFSCREEN_STATUS" }, {}, (value) => {
				activeStatus = value;
			}),
			false,
		);
		assert.deepEqual(activeStatus, {
			ok: true,
			activeOperations: 0,
			blobUrlCount: 1,
		});
		assert.equal(scheduledReapers[0].delay, 30 * 60 * 1000);

		allowReap = true;
		scheduledReapers.shift().callback();
		await new Promise((resolve) => originalSetTimeout(resolve, 0));

		let reapedStatus;
		assert.equal(
			listener({ type: "GET_OFFSCREEN_STATUS" }, {}, (value) => {
				reapedStatus = value;
			}),
			false,
		);
		assert.deepEqual(reapedStatus, {
			ok: true,
			activeOperations: 0,
			blobUrlCount: 0,
		});
		assert.deepEqual(runtimeMessages, [
			{ type: "CAN_REAP_BLOB_URL", url: committed.url },
			{ type: "CAN_REAP_BLOB_URL", url: committed.url },
			{ type: "BLOB_URL_REAPED", url: committed.url },
		]);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		delete globalThis.chrome;
	}
});
