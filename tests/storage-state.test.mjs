import assert from "node:assert/strict";
import test from "node:test";

function createStorageArea(initial = {}, delayMilliseconds = 2) {
  const values = structuredClone(initial);
  const delay = () => new Promise((resolve) => setTimeout(resolve, delayMilliseconds));

  return {
    values,
    async get(keys) {
      await delay();
      if (keys == null) {
        return structuredClone(values);
      }
      if (typeof keys === "string") {
        return keys in values ? { [keys]: structuredClone(values[keys]) } : {};
      }
      throw new TypeError("The storage mock only supports string and null reads.");
    },
    async set(next) {
      await delay();
      Object.assign(values, structuredClone(next));
    },
    async remove(keys) {
      await delay();
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete values[key];
      }
    },
  };
}

async function loadStorageState({ session = {}, local = {} } = {}) {
  const sessionArea = createStorageArea(session);
  const localArea = createStorageArea(local);
  globalThis.chrome = {
    storage: {
      session: sessionArea,
      local: localArea,
    },
  };
  const module = await import(`../src/lib/storage-state.js?test=${crypto.randomUUID()}`);
  return { module, sessionArea, localArea };
}

test.afterEach(() => {
  delete globalThis.chrome;
});

test("pending downloads are isolated by download ID", async () => {
  const { module, sessionArea } = await loadStorageState({
    session: { unrelated: "keep" },
  });

  await Promise.all([
    module.setPendingDownload(11, { filename: "one.png" }),
    module.setPendingDownload(12, { filename: "two.webp" }),
  ]);

  assert.deepEqual(await module.getPendingDownload(11), { filename: "one.png" });
  assert.deepEqual(await module.getPendingDownload(12), { filename: "two.webp" });
  assert.deepEqual(
    (await module.listPendingDownloads()).sort((a, b) => a.downloadId - b.downloadId),
    [
      { downloadId: 11, payload: { filename: "one.png" } },
      { downloadId: 12, payload: { filename: "two.webp" } },
    ],
  );

  await module.deletePendingDownload(11);
  assert.equal(await module.getPendingDownload(11), null);
  assert.equal(sessionArea.values.unrelated, "keep");
});

test("concurrent history appends do not overwrite each other", async () => {
  const { module, localArea } = await loadStorageState();

  await Promise.all([
    module.appendSaveHistory({ id: "first", requestedPath: "first.png" }),
    module.appendSaveHistory({ id: "second", requestedPath: "second.png" }),
  ]);

  assert.deepEqual(
    localArea.values.saveHistory.map((entry) => entry.id).sort(),
    ["first", "second"],
  );
});

test("history mutations stay ordered when clear races with appends", async () => {
  const { module, localArea } = await loadStorageState();

  const firstAppend = module.appendSaveHistory({ id: "before-clear" });
  const clear = module.clearSaveHistory();
  const secondAppend = module.appendSaveHistory({ id: "after-clear" });
  await Promise.all([firstAppend, clear, secondAppend]);

  assert.deepEqual(localArea.values.saveHistory.map((entry) => entry.id), [
    "after-clear",
  ]);
});

test("history IDs are de-duplicated and the latest value wins", async () => {
  const { module, localArea } = await loadStorageState();

  await module.appendSaveHistory({ id: "same", error: "old" });
  await module.appendSaveHistory({ id: "same", finalPath: "new.webp" });

  assert.equal(localArea.values.saveHistory.length, 1);
  assert.equal(localArea.values.saveHistory[0].id, "same");
  assert.equal(localArea.values.saveHistory[0].finalPath, "new.webp");
  assert.equal(localArea.values.saveHistory[0].error, "");
});

test("activity IDs are de-duplicated for retry-safe feedback", async () => {
  const { module, localArea } = await loadStorageState();

  await module.appendActivity({ id: "same", message: "first" });
  await module.appendActivity({ id: "same", message: "retry" });

  assert.equal(localArea.values.recentActivity.length, 1);
  assert.equal(localArea.values.recentActivity[0].message, "retry");
});

test("sanitizeSaveHistory drops unused and privacy-sensitive legacy fields", async () => {
  const { module, localArea } = await loadStorageState({
    local: {
      saveHistory: [
        {
          id: "legacy",
          status: "interrupted",
          action: "copy-path",
          format: "png",
          requestedPath: "requested.png",
          finalPath: "final.png",
          copiedPath: true,
          error: "disk full",
          captureType: "screenshot",
          screenshotMode: "full-page",
          createdAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          srcUrl: "https://private.example/image.png",
          pageTitle: "Private page",
          absoluteLocalPath: "C:\\Users\\person\\Downloads\\final.png",
        },
      ],
    },
  });

  await module.sanitizeSaveHistory();

  assert.deepEqual(Object.keys(localArea.values.saveHistory[0]).sort(), [
    "action",
    "captureType",
    "copiedPath",
    "createdAt",
    "error",
    "finalPath",
    "finishedAt",
    "format",
    "id",
    "requestedPath",
    "screenshotMode",
    "status",
  ]);
  assert.equal(JSON.stringify(localArea.values.saveHistory).includes("private.example"), false);
  assert.equal(JSON.stringify(localArea.values.saveHistory).includes("Private page"), false);
});
