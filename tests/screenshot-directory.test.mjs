import assert from "node:assert/strict";
import test from "node:test";
import {
  createScreenshotDirectorySink,
  loadScreenshotDirectory,
  storeScreenshotDirectory,
} from "../src/lib/screenshot-directory.js";

function createDirectory({ names = [], failure, failAt, abortFailure, afterMissing, beforeOpen, beforeWrite } = {}) {
  const files = new Map(names.map((name) => [name, "existing"]));
  const events = [];
  const directory = {
    kind: "directory",
    async *keys() {
      yield* files.keys();
    },
    async getFileHandle(name, { create }) {
      events.push(["get", name, create]);
      if (failAt === "get") throw failure;
      if (!files.has(name)) {
        if (!create) {
          await afterMissing?.(name, files);
          throw new DOMException("Missing", "NotFoundError");
        }
        files.set(name, "");
      }
      return {
        async getFile() { return { size: new Blob([files.get(name)]).size, lastModified: 0 }; },
        async createWritable() {
          events.push(["open", name]);
          if (failAt === "open") throw failure;
          await beforeOpen?.(name, files);
          let content;
          return {
            async write(blob) {
              events.push(["write", name]);
              await beforeWrite?.(name, files);
              if (failAt === "write") throw failure;
              content = await blob.text();
            },
            async close() {
              events.push(["close", name]);
              if (failAt === "close") throw failure;
              files.set(name, content);
            },
            async abort() {
              events.push(["abort", name]);
              if (abortFailure) throw abortFailure;
            },
          };
        },
      };
    },
  };
  return { directory, files, events };
}

const page = (index, partial = false) => ({ index, partial, blob: new Blob([`page ${index}`]) });
const batchId = index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const name = (index, extension = "png", batch = 1, partial = false) =>
  `example-${batchId(batch)}-${String(index).padStart(3, "0")}${partial ? "-partial" : ""}.${extension}`;

test.beforeEach(t => {
  let batch = 0;
  t.mock.method(crypto, "randomUUID", () => batchId(++batch));
});

test("pages keep one base name and use padded sequence numbers", async () => {
  const { directory, files } = createDirectory();
  const sink = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  assert.equal(await sink.savePage(page(1)), name(1));
  assert.equal(await sink.savePage(page(2)), name(2));
  assert.equal(await sink.savePage(page(3, true)), name(3, "png", 1, true));
  assert.deepEqual([...files], [
    [name(1), "page 1"],
    [name(2), "page 2"],
    [name(3, "png", 1, true), "page 3"],
  ]);
});

test("another capture with the same name gets one new base for its entire batch", async () => {
  const { directory, files } = createDirectory({ names: ["example-008-partial.png", "example-2-001.png"] });
  const sink = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  assert.equal(await sink.savePage(page(1)), name(1));
  assert.equal(await sink.savePage(page(2)), name(2));
  assert.equal(files.get("example-008-partial.png"), "existing");
  assert.equal(files.get("example-2-001.png"), "existing");
  const next = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  assert.equal(await next.savePage(page(1)), name(1, "png", 2));
});

test("long filenames retain the entire unique batch suffix", async () => {
  const stem = "a".repeat(80);
  const { directory, files } = createDirectory({ names: [`${stem}-001.webp`] });
  const sink = await createScreenshotDirectorySink({ directory, filename: `${stem}.webp` });
  const actual = await sink.savePage(page(1));
  assert.equal(actual, `${"a".repeat(43)}-${batchId(1)}-001.webp`);
  assert.equal(files.get(`${stem}-001.webp`), "existing");
});

test("a file appearing after batch initialization is never overwritten", async () => {
  const { directory, files, events } = createDirectory();
  const sink = await createScreenshotDirectorySink({ directory, filename: "example.jpg" });
  await sink.savePage(page(1));
  files.set(name(2, "jpg"), "external file");
  await assert.rejects(sink.savePage(page(2)), { name: "InvalidModificationError" });
  assert.equal(files.get(name(2, "jpg")), "external file");
  assert.equal(events.filter(([kind, filename, create]) => kind === "get" && filename === name(2, "jpg") && create).length, 0);
});

test("permission failures during file lookup propagate without creating a file", async () => {
  const failure = new DOMException("Access denied", "NotAllowedError");
  const { directory, files, events } = createDirectory({ failure, failAt: "get" });
  const sink = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  await assert.rejects(sink.savePage(page(1)), (error) => error === failure);
  assert.deepEqual(events, [["get", name(1), false]]);
  assert.equal(files.size, 0);
});

for (const failAt of ["open", "write", "close"]) {
  test(`${failAt} failure aborts an opened stream and stops subsequent writes without retry`, async () => {
    const failure = new DOMException("Write denied or disk full", "NotAllowedError");
    const { directory, files, events } = createDirectory({
      failure,
      failAt,
      abortFailure: new Error("Stream already errored"),
    });
    const sink = await createScreenshotDirectorySink({ directory, filename: "example.png" });
    await assert.rejects(sink.savePage(page(1)), (error) => error === failure);
    const firstEvents = [...events];
    await assert.rejects(sink.savePage(page(2)), (error) => error === failure);
    assert.deepEqual(events, firstEvents);
    assert.equal(events.filter(([kind]) => kind === "open").length, 1);
    assert.equal(events.filter(([kind]) => kind === "abort").length, failAt === "open" ? 0 : 1);
    assert.equal(files.get(name(1)), "");
    assert.equal(files.has(name(2)), false);
  });
}

test("concurrent save requests wait for each previous write and close", async () => {
  let releaseWrite;
  let writingStarted;
  const started = new Promise((resolve) => { writingStarted = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const { directory, files, events } = createDirectory({
    async beforeWrite(filename) {
      if (filename === name(1)) {
        writingStarted();
        await gate;
      }
    },
  });
  const sink = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  let firstDone = false;
  const first = sink.savePage(page(1)).then((name) => { firstDone = true; return name; });
  const second = sink.savePage(page(2));
  await started;
  assert.equal(firstDone, false);
  assert.equal(files.has(name(2)), false);
  releaseWrite();
  assert.deepEqual(await Promise.all([first, second]), [name(1), name(2)]);
  const closesFirst = events.findIndex(([kind, filename]) => kind === "close" && filename === name(1));
  const opensSecond = events.findIndex(([kind, filename]) => kind === "open" && filename === name(2));
  assert.ok(opensSecond > closesFirst);
});

for (const phase of ["afterMissing", "beforeOpen", "beforeWrite"]) {
  test(`external content arriving at ${phase} is preserved and stops the batch`, async () => {
    const { directory, files, events } = createDirectory({
      [phase](filename, files) { files.set(filename, "external original data"); },
    });
    const sink = await createScreenshotDirectorySink({ directory, filename: "example.png" });
    await assert.rejects(sink.savePage(page(1)), { name: "InvalidModificationError" });
    assert.equal(files.get(name(1)), "external original data");
    assert.equal(events.some(([kind]) => kind === "close"), false);
    assert.equal(events.filter(([kind]) => kind === "abort").length, phase === "afterMissing" ? 0 : 1);
    const attempts = events.length;
    await assert.rejects(sink.savePage(page(2)), { name: "InvalidModificationError" });
    assert.equal(events.length, attempts);
  });
}

test("two batches started before either writes use different filenames", async () => {
  const { directory, files } = createDirectory();
  const first = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  const second = await createScreenshotDirectorySink({ directory, filename: "example.png" });
  assert.deepEqual(await Promise.all([first.savePage(page(1)), second.savePage(page(1))]), [name(1), name(1, "png", 2)]);
  assert.equal(files.size, 2);
});

function createIndexedDB() {
  const values = new Map();
  const state = { values, closes: 0, completes: 0, failTransaction: null, failOpen: null };
  let initialized = false;
  const database = {
    createObjectStore() {},
    close() { state.closes += 1; },
    transaction() {
      const transaction = {
        objectStore() {
          function requestOperation(operation) {
            const request = {};
            queueMicrotask(() => {
              if (state.failTransaction) {
                transaction.error = state.failTransaction;
                transaction.onabort();
              } else {
                request.result = operation();
                state.completes += 1;
                transaction.oncomplete();
              }
            });
            return request;
          }
          return {
            get(key) { return requestOperation(() => values.get(key)); },
            put(value, key) { return requestOperation(() => { values.set(key, value); return key; }); },
          };
        },
      };
      return transaction;
    },
  };
  state.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        if (state.failOpen) {
          request.error = state.failOpen;
          request.onerror();
          return;
        }
        request.result = database;
        if (!initialized) {
          initialized = true;
          request.onupgradeneeded();
        }
        request.onsuccess();
      });
      return request;
    },
  };
  return state;
}

function mockIndexedDB(t, indexedDB) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  });
}

test("directory storage persists one handle, replaces it, and closes each database connection", async (t) => {
  const state = createIndexedDB();
  mockIndexedDB(t, state.indexedDB);
  assert.equal(await loadScreenshotDirectory(), null);
  const first = createDirectory().directory;
  const second = createDirectory().directory;
  await storeScreenshotDirectory(first);
  assert.equal(await loadScreenshotDirectory(), first);
  await storeScreenshotDirectory(second);
  assert.equal(await loadScreenshotDirectory(), second);
  assert.equal(state.values.size, 1);
  assert.equal(state.completes, 5);
  assert.equal(state.closes, 5);
});

test("directory storage reports persistence and opening failures", async (t) => {
  const state = createIndexedDB();
  mockIndexedDB(t, state.indexedDB);
  const failure = new DOMException("Storage unavailable", "QuotaExceededError");
  state.failTransaction = failure;
  await assert.rejects(storeScreenshotDirectory(createDirectory().directory), (error) => error === failure);
  assert.equal(state.closes, 1);
  assert.equal(state.values.size, 0);
  state.failOpen = failure;
  await assert.rejects(loadScreenshotDirectory(), (error) => error === failure);
});
