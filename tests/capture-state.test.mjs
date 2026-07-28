import assert from "node:assert/strict";
import test from "node:test";

function createSessionStorage(delayMilliseconds = 2) {
	const values = {};
	const delay = () =>
		new Promise((resolve) => setTimeout(resolve, delayMilliseconds));

	return {
		values,
		async get(key) {
			await delay();
			return key in values ? { [key]: structuredClone(values[key]) } : {};
		},
		async set(next) {
			await delay();
			Object.assign(values, structuredClone(next));
		},
		async remove(key) {
			await delay();
			delete values[key];
		},
	};
}

async function loadCaptureState() {
	const session = createSessionStorage();
	globalThis.chrome = { storage: { session } };
	const module = await import(
		`../src/lib/capture-state.js?test=${crypto.randomUUID()}`
	);
	return { module, session };
}

test.afterEach(() => {
	delete globalThis.chrome;
});

test("concurrent screenshot requests from one worker have one owner", async () => {
	const { module } = await loadCaptureState();
	const lease = { workerId: "worker-a", tabId: 10, pageState: null };

	const [first, second] = await Promise.all([
		module.acquireScreenshotLease(lease),
		module.acquireScreenshotLease({ ...lease, tabId: 11 }),
	]);

	assert.equal(first.acquired, true);
	assert.equal(second.acquired, false);
	assert.equal((await module.getScreenshotLease()).tabId, 10);
});

test("a new service worker atomically takes over and exposes the stale lease", async () => {
	const { module } = await loadCaptureState();
	const staleLease = {
		workerId: "worker-old",
		tabId: 20,
		pageState: { originalScrollY: 120 },
	};
	await module.acquireScreenshotLease(staleLease);

	const takeover = await module.acquireScreenshotLease({
		workerId: "worker-new",
		tabId: 21,
		pageState: null,
	});

	assert.equal(takeover.acquired, true);
	assert.deepEqual(takeover.previousLease, staleLease);
	assert.equal((await module.getScreenshotLease()).workerId, "worker-new");
});

test("only the owning worker can update or release a screenshot lease", async () => {
	const { module } = await loadCaptureState();
	await module.acquireScreenshotLease({
		workerId: "worker-a",
		tabId: 30,
		pageState: null,
	});

	assert.equal(
		await module.updateScreenshotLease("worker-b", { pageState: { x: 1 } }),
		false,
	);
	assert.equal(await module.releaseScreenshotLease("worker-b"), false);
	assert.equal(
		await module.updateScreenshotLease("worker-a", { pageState: { x: 2 } }),
		true,
	);
	assert.deepEqual((await module.getScreenshotLease()).pageState, { x: 2 });
	assert.equal(await module.releaseScreenshotLease("worker-a"), true);
	assert.equal(await module.getScreenshotLease(), null);
});

test("stale recovery removes only another worker's lease", async () => {
	const { module } = await loadCaptureState();
	await module.acquireScreenshotLease({ workerId: "worker-a", tabId: 40 });

	assert.equal(await module.takeStaleScreenshotLease("worker-a"), null);
	const stale = await module.takeStaleScreenshotLease("worker-b");
	assert.equal(stale.workerId, "worker-a");
	assert.equal(await module.getScreenshotLease(), null);
});

test("capture-rate reservations are serialized and persisted", async () => {
	const { module, session } = await loadCaptureState();
	const [first, second] = await Promise.all([
		module.waitForScreenshotCaptureSlot(25),
		module.waitForScreenshotCaptureSlot(25),
	]);

	assert.ok(second - first >= 20, `expected a throttled gap, got ${second - first}ms`);
	assert.equal(session.values.lastScreenshotCaptureAt, second);
});
