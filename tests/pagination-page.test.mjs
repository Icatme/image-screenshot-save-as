import assert from "node:assert/strict";
import test from "node:test";

const REQUEST_KEY = "screenshotPaginationRequest";

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Pagination page handler did not finish");
    await new Promise(setImmediate);
  }
}

async function withPage(initialStatus, scenario) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      disabled: false, dataset: {}, textContent: "", listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
    });
    return nodes.get(selector);
  };
  node('input[name="mode"]:checked:not(:disabled)').value = "a4";
  node('input[name="mode"]:checked').value = "a4";
  let changeListener;
  let request = { id: "job", status: initialStatus, width: 8000, height: 33000, format: "png", action: "save", savedCount: 2, directoryName: "Screenshots", pendingFilename: "last-003.png" };
  const sent = [];
  const state = {
    sent, node, closed: false,
    get request() { return request; },
    set request(value) { request = value; },
    publishInterruption() {
      request = { ...request, status: "interrupted" };
      changeListener({ [REQUEST_KEY]: { newValue: request } }, "session");
    },
  };
  const directory = { kind: "directory", name: "Screenshots", requestPermission: async () => "granted" };
  const globals = {
    location: { hash: "#job" },
    document: {
      documentElement: {}, querySelector: node, querySelectorAll: () => [], addEventListener() {},
    },
    window: { close() { state.closed = true; } },
    chrome: {
      runtime: {
        getURL: () => `data:application/json,${encodeURIComponent(JSON.stringify({
          paginationInterrupted: { message: "Saved $COUNT$ in $DIRECTORY$; capture interrupted.", placeholders: { count: { content: "$1" }, directory: { content: "$2" } } },
          paginationUnconfirmedPage: { message: "Check $FILE$.", placeholders: { file: { content: "$1" } } },
        }))}`,
        async sendMessage(message) {
          sent.push(message);
          if (message.type === "GET_PAGED_SCREENSHOT_STATUS") return { ok: true, request: { ...request } };
          if (message.type === "SAVE_PAGED_SCREENSHOT") {
            request = { ...request, status: "interrupted" };
            throw new Error("Message port closed");
          }
          throw new Error("Unexpected message");
        },
      },
      i18n: { getUILanguage: () => "en", getMessage: key => key },
      storage: {
        sync: { async get() { return { localeOverride: "auto" }; } },
        session: {
          async get() { return { [REQUEST_KEY]: request }; },
          async remove() { request = null; },
        },
        onChanged: { addListener(callback) { changeListener = callback; } },
      },
    },
    indexedDB: {
      open() {
        const open = {};
        queueMicrotask(() => {
          open.result = {
            close() {},
            transaction() {
              const tx = { objectStore() {
                const operation = result => {
                  queueMicrotask(() => tx.oncomplete());
                  return { result };
                };
                return { get: () => operation(directory), put: () => operation("screenshot") };
              } };
              return tx;
            },
          };
          open.onsuccess();
        });
        return open;
      },
    },
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    await import(`../src/pagination/pagination.js?test=${crypto.randomUUID()}`);
    await waitUntil(() => initialStatus === "interrupted" ? node("#status").textContent.includes("capture interrupted") : sent.length && node("#directory-name").textContent === "Screenshots");
    await scenario(state);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function assertInterrupted(state) {
  assert.match(state.node("#status").textContent, /Saved 2 in Screenshots/);
  assert.match(state.node("#status").textContent, /Check last-003\.png/);
  assert.equal(state.node("#controls").disabled, true);
  assert.equal(state.node("#save").disabled, true);
  assert.equal(state.node("#cancel").disabled, false);
  assert.equal(state.node("#cancel").textContent, "paginationClose");
}

test("reopening an interrupted confirmation waits for worker recovery and shows saved progress", async () => {
  await withPage("interrupted", async state => {
    assert.deepEqual(state.sent, [{ type: "GET_PAGED_SCREENSHOT_STATUS", requestId: "job" }]);
    assertInterrupted(state);
    await state.node("#cancel").listeners.click();
    assert.equal(state.closed, true);
    assert.equal(state.request, null);
  });
});

test("a disconnected save request wakes the replacement worker and presents its interruption result", async () => {
  await withPage("choosing", async state => {
    await state.node("#form").listeners.submit({ preventDefault() {} });
    assert.deepEqual(state.sent.map(message => message.type), ["GET_PAGED_SCREENSHOT_STATUS", "SAVE_PAGED_SCREENSHOT", "GET_PAGED_SCREENSHOT_STATUS"]);
    assertInterrupted(state);
  });
});

test("a persisted interruption updates an already open confirmation", async () => {
  await withPage("choosing", async state => {
    state.publishInterruption();
    assertInterrupted(state);
  });
});
