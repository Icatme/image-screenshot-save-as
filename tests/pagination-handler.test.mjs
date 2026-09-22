import assert from "node:assert/strict";
import test from "node:test";

const REQUEST_KEY = "screenshotPaginationRequest";
const CHOOSER_URL = "chrome-extension://test/src/pagination/pagination.html";

function storageArea(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(keys) {
      if (keys == null) return { ...state };
      if (typeof keys === "string") return Object.hasOwn(state, keys) ? { [keys]: state[keys] } : {};
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback]));
    },
    async set(values) { Object.assign(state, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    async setAccessLevel() {},
  };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Pagination handler did not finish.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function withHandler(options, scenario) {
  const state = {
    tab: { id: 7, windowId: 3, title: "Long page", url: "https://example.test/long" },
    documentId: "original-document",
    activeTabId: 7,
    width: options.width ?? 8_000,
    height: options.height ?? 33_000,
    viewportHeight: options.viewportHeight ?? 12_000,
    permission: options.permission ?? "granted",
    files: new Map(),
    scripts: [],
    createdTabs: [],
    chooserNavigations: [],
    menus: [],
    captures: 0,
    permissionChecks: 0,
    directoryReads: 0,
    downloads: [],
    notifications: [],
    events: [],
    encodedSizes: [],
    progressDuringClose: [],
    local: storageArea(options.local),
    session: storageArea(options.session),
  };
  const directory = {
    kind: "directory",
    name: "Chosen screenshots",
    async queryPermission({ mode }) {
      assert.equal(mode, "readwrite");
      state.permissionChecks += 1;
      await state.onQueryPermission?.();
      return state.permission;
    },
    async *keys() { yield* state.files.keys(); },
    async getFileHandle(name, { create }) {
      if (!state.files.has(name)) {
        if (!create) throw new DOMException("Missing", "NotFoundError");
        state.files.set(name, "");
      }
      return {
        async getFile() { return { size: new Blob([state.files.get(name)]).size, lastModified: 0 }; },
        async createWritable() {
          let blob;
          return {
            async write(value) { blob = value; },
            async close() {
              state.progressDuringClose.push(structuredClone(state.session.state[REQUEST_KEY]));
              state.events.push(["saved", name]);
              state.files.set(name, await blob.text());
            },
            async abort() {},
          };
        },
      };
    },
  };
  const listeners = {};
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      getURL(path) {
        return path.startsWith("_locales/") ? "data:application/json,%7B%7D" : `chrome-extension://test/${path}`;
      },
      async getContexts() { return options.singleDownload ? [{}] : []; },
      async sendMessage(message) {
        if (!options.singleDownload) throw new Error("Directory captures must not use the clipboard/download offscreen path.");
        if (message.type === "COMMIT_BLOB_URL") return { ok: true, url: "blob:single-screenshot" };
        if (message.type === "GET_OFFSCREEN_STATUS") return { ok: true, activeOperations: 0, blobUrlCount: 1 };
        return { ok: true };
      },
    },
    i18n: { getUILanguage: () => "en", getMessage: (key) => key },
    storage: {
      local: state.local,
      session: state.session,
      sync: storageArea({ localeOverride: "auto" }),
      onChanged: { addListener() {} },
    },
    contextMenus: {
      onClicked: { addListener(listener) { listeners.menu = listener; } },
      async removeAll() { state.menus.length = 0; },
      create(menu) { state.menus.push(menu); },
    },
    downloads: {
      onChanged: { addListener() {} },
      async search() { return []; },
      async download(value) { state.downloads.push(value); return 1; },
    },
    action: {
      onClicked: { addListener() {} },
      async setTitle() {},
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
    notifications: {
      async create(id, value) { state.notifications.push(value); return id; },
    },
    tabs: {
      async get(id) { assert.equal(id, state.tab.id); return { ...state.tab }; },
      async create(value) {
        state.createdTabs.push(value);
        if (value.active !== false) state.activeTabId = 99;
        return { id: 99 };
      },
      async update(id, value) {
        if (id === 99) {
          assert.equal(state.session.state[REQUEST_KEY].chooserTabId, id);
          state.chooserNavigations.push(value);
          state.activeTabId = 99;
          return;
        }
        assert.deepEqual(value, { active: true });
        state.events.push(["activate", id]);
        state.activeTabId = options.switchAfterActivation ? 55 : id;
      },
      async query() {
        return [{ ...state.tab, id: state.activeTabId }];
      },
      async captureVisibleTab(windowId, value) {
        assert.equal(windowId, state.tab.windowId);
        assert.deepEqual(value, { format: "png" });
        state.events.push(["capture", state.activeTabId]);
        state.captures += 1;
        if (options.captureFails) throw new Error("First capture failed");
        if (options.changeDocumentDuringCapture) state.documentId = "replacement-document";
        return "data:image/png;base64,AA==";
      },
    },
    scripting: {
      async executeScript({ target, func, args }) {
        state.scripts.push({ name: func.name, target });
        assert.equal(target.tabId, state.tab.id);
        if (target.documentIds && target.documentIds[0] !== state.documentId) {
          throw new Error("Target document is no longer present");
        }
        let result;
        switch (func.name) {
          case "preparePageForScreenshot":
            result = {
              recoveryToken: "capture-token", scrollTarget: "window",
              originalScrollX: 0, originalScrollY: 0,
              viewportWidth: state.width, viewportHeight: state.viewportHeight,
              pageHeight: state.height, maxScrollY: Math.max(0, state.height - state.viewportHeight),
              devicePixelRatio: 1,
            };
            break;
          case "scrollPageForScreenshot": result = { scrollY: args[1] }; break;
          case "restorePageAfterScreenshot":
          case "isPagePreparedForScreenshot": result = true; break;
          default: throw new Error(`Unexpected script: ${func.name}`);
        }
        return [{ documentId: state.documentId, result }];
      },
    },
    offscreen: { async createDocument() {}, async closeDocument() {} },
  };
  const overrides = {
    chrome,
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            close() {},
            transaction() {
              const transaction = {
                objectStore() {
                  return {
                    get() {
                      state.directoryReads += 1;
                      const read = { result: directory };
                      queueMicrotask(() => transaction.oncomplete());
                      return read;
                    },
                  };
                },
              };
              return transaction;
            },
          };
          request.onsuccess();
        });
        return request;
      },
    },
    createImageBitmap: async () => ({ width: state.width, height: state.viewportHeight, close() {} }),
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext() { return { drawImage() {}, fillRect() {} }; }
      async convertToBlob({ type }) {
        state.encodedSizes.push([this.width, this.height]);
        return new Blob([`${this.width}x${this.height}`], { type });
      }
    },
  };
  const originals = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalSetTimeout = globalThis.setTimeout;
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.setTimeout = (callback, delay, ...args) => delay === 8_000 ? 0
    : originalSetTimeout(callback, delay <= 550 ? 0 : delay, ...args);
  try {
    await import(`../src/background/service-worker.js?pagination=${crypto.randomUUID()}`);
    const clickFullPage = () => listeners.menu({ menuItemId: "screenshot:full-page:png:save", pageUrl: state.tab.url }, { ...state.tab });
    state.open = async () => {
      clickFullPage();
      await waitUntil(() => state.session.state[REQUEST_KEY]?.chooserTabId && !state.session.state.activeScreenshot);
      return state.session.state[REQUEST_KEY];
    };
    state.captureSingle = async () => {
      clickFullPage();
      await waitUntil(() => state.downloads.length === 1 && !state.session.state.activeScreenshot);
    };
    state.send = (message = {}, sender) => new Promise((resolve) => {
      const request = state.session.state[REQUEST_KEY];
      assert.equal(listeners.message({
        type: "SAVE_PAGED_SCREENSHOT", requestId: request?.id, mode: "a4", ...message,
      }, sender ?? { url: `${CHOOSER_URL}#${request?.id}`, tab: { id: 99 } }, resolve), true);
    });
    state.startup = async () => {
      listeners.startup();
      await waitUntil(() => state.menus.some(({ id }) => id === "screenshot:full-page:webp:save"));
    };
    state.restart = async () => {
      await import(`../src/background/service-worker.js?pagination=${crypto.randomUUID()}`);
      return state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" });
    };
    await scenario(state);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("oversized single capture only opens the choice page and releases its lease", async () => {
  await withHandler({ height: 40_000 }, async (state) => {
    const request = await state.open();
    assert.equal(Object.hasOwn(request, "preferredMode"), false);
    assert.equal(request.documentId, "original-document");
    assert.equal(request.height, 40_000);
    assert.equal(request.status, "choosing");
    assert.equal(state.createdTabs[0].url, "about:blank");
    assert.equal(state.createdTabs[0].active, false);
    assert.deepEqual(state.chooserNavigations[0], { url: `${CHOOSER_URL}#${request.id}`, active: true });
    assert.equal(state.captures, 0);
    assert.equal(state.directoryReads, 0);
    assert.equal(state.downloads.length, 0);
    assert.equal(state.files.size, 0);
    assert.ok(state.scripts.some(({ name }) => name === "restorePageAfterScreenshot"));
  });
});

test("a full page within the limit saves one image without opening pagination options", async () => {
  await withHandler({ width: 100, height: 300, viewportHeight: 50, singleDownload: true }, async (state) => {
    await state.captureSingle();
    assert.equal(state.createdTabs.length, 0);
    assert.equal(state.session.state[REQUEST_KEY], undefined);
    assert.equal(state.directoryReads, 0);
    assert.equal(state.files.size, 0);
    assert.deepEqual(state.encodedSizes, [[100, 300]]);
    assert.deepEqual(state.downloads, [{
      url: "blob:single-screenshot", filename: "Long-page-full-page-screenshot.png",
      saveAs: true, conflictAction: "uniquify",
    }]);
  });
});

test("foreign senders, stale requests and unsupported modes cannot load the directory or capture", async () => {
  await withHandler({}, async (state) => {
    const request = await state.open();
    for (const [message, sender] of [
      [{}, { url: "https://example.test/", tab: { id: 99 } }],
      [{}, { url: CHOOSER_URL, tab: { id: 7 } }],
      [{ requestId: "previous-request" }],
      [{ mode: "single" }],
      [{ mode: "shrink" }],
    ]) {
      assert.equal((await state.send(message, sender)).ok, false);
    }
    state.session.state[REQUEST_KEY] = { ...request, status: "capturing" };
    assert.equal((await state.send()).ok, false);
    state.session.state[REQUEST_KEY] = { ...request, documentId: "" };
    assert.equal((await state.send()).ok, false);
    assert.equal(state.captures, 0);
    assert.equal(state.directoryReads, 0);
    assert.equal(state.files.size, 0);
  });
});

test("a confirmation replaced while permissions are checked cannot overwrite or remove its successor", async () => {
  await withHandler({}, async (state) => {
    const request = await state.open();
    const replacement = { ...request, id: "newer-confirmation" };
    state.onQueryPermission = async () => { state.session.state[REQUEST_KEY] = replacement; };
    assert.equal((await state.send()).ok, false);
    assert.deepEqual(state.session.state[REQUEST_KEY], replacement);
    assert.equal(state.captures, 0);
    assert.equal(state.files.size, 0);
    assert.equal(state.session.state.activeScreenshot, undefined);
  });
});

test("confirmed pagination reactivates the source tab, writes numbered files, records history and cleans up", async () => {
  await withHandler({}, async (state) => {
    const request = await state.open();
    assert.equal(state.activeTabId, 99);
    const result = await state.send();
    assert.equal(result.ok, true);
    assert.equal(result.savedCount, 3);
    assert.equal(result.directoryName, "Chosen screenshots");
    const names = [...state.files.keys()];
    assert.match(names[0], /^Long-page-full-page-screenshot-[a-f0-9-]{36}-001\.png$/);
    assert.equal(names[1], names[0].replace(/001\.png$/, "002.png"));
    assert.equal(names[2], names[0].replace(/001\.png$/, "003.png"));
    assert.deepEqual([...state.files.values()], ["8000x11314", "8000x11314", "8000x11314"]);
    assert.deepEqual(state.events[0], ["activate", 7]);
    assert.ok(state.events.filter(([type]) => type === "capture").every(([, id]) => id === 7));
    assert.equal(state.session.state[REQUEST_KEY], undefined);
    assert.equal(state.session.state.activeScreenshot, undefined);
    assert.equal(state.downloads.length, 0);
    const history = state.local.state.saveHistory;
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(({ id }) => id).sort(), [1, 2, 3].map((index) => `${request.id}-${index}`).sort());
    for (const item of history) {
      assert.equal(item.status, "completed");
      assert.equal(item.action, "save");
      assert.equal(item.copiedPath, false);
      assert.equal(item.finalPath, "");
      assert.match(item.requestedPath, /^Chosen screenshots\/Long-page-full-page-screenshot-[a-f0-9-]{36}-\d{3}\.png$/);
    }
    assert.deepEqual(state.progressDuringClose.map(progress => progress.savedCount), [0, 1, 2]);
    assert.deepEqual(state.progressDuringClose.map(progress => progress.pendingFilename), names);
    assert.ok(state.progressDuringClose.every(progress => progress.status === "capturing" && progress.workerId));
    assert.equal(state.progressDuringClose[1].lastHistory.id, `${request.id}-1`);
    const preparations = state.scripts.filter(({ name }) => name === "preparePageForScreenshot");
    assert.deepEqual(preparations[1].target.documentIds, ["original-document"]);
    assert.equal((await state.send({ requestId: request.id })).ok, false);
    assert.equal(state.files.size, 3);
  });
});

test("confirmed longest pagination saves the fewest numbered images at the supported edge", async () => {
  await withHandler({ width: 100, height: 40_000, viewportHeight: 20_000 }, async (state) => {
    await state.open();
    const result = await state.send({ mode: "longest" });
    assert.equal(result.ok, true);
    assert.equal(result.savedCount, 2);
    const names = [...state.files.keys()];
    assert.match(names[0], /^Long-page-full-page-screenshot-[a-f0-9-]{36}-001\.png$/);
    assert.equal(names[1], names[0].replace(/001\.png$/, "002.png"));
    assert.deepEqual([...state.files.values()], ["100x32767", "100x7233"]);
    assert.equal(state.captures, 2);
    assert.equal(state.downloads.length, 0);
  });
});

test("denied directory permission leaves confirmation available and never starts capture", async () => {
  await withHandler({ permission: "denied" }, async (state) => {
    await state.open();
    const scriptsBefore = state.scripts.length;
    const result = await state.send();
    assert.equal(result.ok, false);
    assert.equal(state.permissionChecks, 1);
    assert.equal(state.scripts.length, scriptsBefore);
    assert.equal(state.captures, 0);
    assert.equal(state.files.size, 0);
    assert.equal(state.session.state.activeScreenshot, undefined);
    assert.equal(state.session.state[REQUEST_KEY].status, "choosing");
  });
});

test("a changed source URL or document cannot be captured by an old confirmation", async (t) => {
  for (const change of ["url", "document"]) {
    await t.test(change, async () => withHandler({}, async (state) => {
      await state.open();
      if (change === "url") state.tab.url = "https://example.test/replacement";
      else state.documentId = "replacement-document";
      assert.equal((await state.send()).ok, false);
      assert.equal(state.captures, 0);
      assert.equal(state.files.size, 0);
      assert.equal(state.session.state.activeScreenshot, undefined);
    }));
  }
});

test("switching tabs or navigating during capture never writes pixels from the wrong page", async (t) => {
  for (const options of [{ switchAfterActivation: true }, { changeDocumentDuringCapture: true }]) {
    await t.test(Object.keys(options)[0], async () => withHandler(options, async (state) => {
      await state.open();
      assert.equal((await state.send()).ok, false);
      assert.equal(state.files.size, 0);
      assert.equal(state.captures, options.switchAfterActivation ? 0 : 1);
      assert.equal(state.session.state[REQUEST_KEY], undefined);
      assert.equal(state.session.state.activeScreenshot, undefined);
      assert.equal(state.local.state.saveHistory, undefined);
    }));
  }
});

test("full-page menu goes directly to image formats without duplicate layout choices", async () => {
  await withHandler({}, async (state) => {
    await state.startup();
    const children = state.menus.filter(({ parentId }) => parentId === "screenshot-mode:full-page");
    assert.deepEqual(children.map(({ id }) => id), ["png", "jpg", "webp"].map((format) => `screenshot-format:full-page:${format}`));
    assert.ok(state.menus.every(({ id }) => !id.startsWith("screenshot-layout:") && !id.includes("full-page-a4") && !id.includes("full-page-longest")));
    assert.equal(state.menus.filter(({ id }) => id.startsWith("screenshot:full-page:")).length, 6);
    assert.ok(state.menus.some(({ id }) => id === "screenshot:full-page:png:copy-path"));
  });
});

test("failure of the first capture produces no file or history and releases confirmation and lease", async () => {
  await withHandler({ captureFails: true }, async (state) => {
    await state.open();
    assert.equal((await state.send()).ok, false);
    assert.equal(state.captures, 1);
    assert.equal(state.files.size, 0);
    assert.equal(state.downloads.length, 0);
    assert.equal(state.local.state.saveHistory, undefined);
    assert.equal(state.session.state[REQUEST_KEY], undefined);
    assert.equal(state.session.state.activeScreenshot, undefined);
  });
});

function interruptedSession({ savedCount = 1, pendingFilename = "", status = "capturing" } = {}) {
  return {
    [REQUEST_KEY]: {
      id: "stopped-request", status, workerId: "previous-worker",
      tab: { id: 7, windowId: 3, url: "https://example.test/long", title: "Long page" },
      documentId: "original-document", chooserTabId: 99,
      format: "png", action: "save", width: 8000, height: 33000,
      savedCount, directoryName: "Chosen screenshots", pendingFilename,
      lastHistory: savedCount ? {
        id: "stopped-request-1", status: "completed", action: "save", format: "png",
        requestedPath: "Chosen screenshots/saved-page-001.png",
        captureType: "screenshot", screenshotMode: "full-page",
        capturedHeight: 11314, totalHeight: 33000,
      } : null,
    },
    activeScreenshot: {
      workerId: "previous-worker", tabId: 7, tabUrl: "https://example.test/long",
      pageState: { documentId: "original-document", recoveryToken: "old-capture" },
    },
  };
}

test("cold-start recovery closes an interrupted batch and preserves its confirmed progress", async () => {
  await withHandler({ session: interruptedSession({ pendingFilename: "saved-page-002.png" }) }, async state => {
    const response = await state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" });
    assert.equal(response.ok, true);
    assert.equal(response.request.status, "interrupted");
    assert.equal(response.request.savedCount, 1);
    assert.equal(response.request.pendingFilename, "saved-page-002.png");
    assert.equal(response.request.interruptionReported, true);
    assert.equal(state.session.state.activeScreenshot, undefined);
    assert.equal(state.notifications.length, 1);
    assert.match(state.notifications[0].message, /paginationInterrupted.*paginationUnconfirmedPage/);
    assert.equal(state.local.state.saveHistory[0].partialCapture, true);
    assert.equal(state.local.state.saveHistory[0].capturedHeight, 11314);
    assert.equal(state.local.state.saveHistory[0].partialReason, "capture_failed");
    assert.equal(state.captures, 0);
    assert.equal(state.directoryReads, 0);
    assert.equal((await state.send()).ok, false, "Recovery must not restart capture");
    assert.equal((await state.restart()).request.status, "interrupted");
    assert.equal(state.notifications.length, 1, "Later worker starts must not duplicate feedback");
    assert.equal(state.local.state.saveHistory.length, 1);
  });
});

test("recovery before the first confirmed page reports zero and does not invent saved history", async () => {
  await withHandler({ session: interruptedSession({ savedCount: 0, pendingFilename: "maybe-saved-001.png" }) }, async state => {
    const response = await state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" });
    assert.equal(response.request.status, "interrupted");
    assert.equal(response.request.savedCount, 0);
    assert.equal(response.request.pendingFilename, "maybe-saved-001.png");
    assert.equal(state.local.state.saveHistory, undefined);
    assert.equal(state.files.size, 0);
    assert.equal(state.notifications.length, 1);
  });
});

test("recovery completes feedback if the previous worker stopped after marking interruption", async () => {
  await withHandler({ session: interruptedSession({ status: "interrupted" }) }, async state => {
    const response = await state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" });
    assert.equal(response.request.interruptionReported, true);
    assert.equal(state.local.state.recentActivity.length, 1);
    assert.equal(state.local.state.recentActivity[0].id, "stopped-request-interrupted");
  });
});

test("waiting confirmations survive worker startup and status cannot be read by another sender", async () => {
  const session = interruptedSession({ status: "choosing", savedCount: 0 });
  delete session.activeScreenshot;
  await withHandler({ session }, async state => {
    const response = await state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" });
    assert.equal(response.request.status, "choosing");
    assert.equal(state.notifications.length, 0);
    for (const sender of [
      { url: "https://example.test", tab: { id: 99 } },
      { url: CHOOSER_URL, tab: { id: 100 } },
    ]) {
      assert.equal((await state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" }, sender)).ok, false);
    }
  });
});

test("a capture finished before worker termination is not relabeled as interrupted", async () => {
  await withHandler({ session: interruptedSession({ status: "completed" }) }, async state => {
    const response = await state.send({ type: "GET_PAGED_SCREENSHOT_STATUS" });
    assert.equal(response.request.status, "completed");
    assert.equal(response.request.savedCount, 1);
    assert.equal(state.notifications.length, 0);
    assert.equal(state.local.state.saveHistory, undefined);
    assert.equal(state.captures, 0);
  });
});
