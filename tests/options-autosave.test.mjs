import assert from "node:assert/strict";
import test from "node:test";

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Settings operation did not finish");
    await new Promise(setImmediate);
  }
}

async function withOptions(scenario, { local = {} } = {}) {
  const elements = new Map();
  function element(tagName = "div") {
    const node = {
      tagName,
      value: "", checked: false, disabled: false, hidden: false, open: false,
      scrollTop: 0, tabIndex: 0, dataset: {}, attributes: {}, listeners: {},
      children: [],
      childNodes: [{ textContent: "" }],
      _textContent: "",
      get textContent() { return this._textContent; },
      set textContent(value) {
        this._textContent = String(value);
        if (value === "") this.children = [];
      },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector() { return { textContent: "" }; },
      append(...items) { this.children.push(...items); },
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() { this.focused = true; },
    };
    return node;
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const timers = new Map();
  const blockers = [];
  const writes = [];
  const sentMessages = [];
  let timerId = 0;
  let stored = { jpgQuality: 0.92, webpQuality: 0.92, silentSave: false, localeOverride: "auto" };
  let localStored = structuredClone(local);
  const storageListeners = [];
  const globals = {
    document: { getElementById: get, createElement: element, documentElement: {} },
    window: {
      confirm: () => true,
      setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout(id) { timers.delete(id); },
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.9.0", manifest_version: 3 }),
        getURL: () => "data:application/json,%7B%7D",
        async sendMessage(message) {
          sentMessages.push(message);
          if (message?.type === "CLEAR_SAVE_HISTORY") {
            delete localStored.saveHistory;
            delete localStored.recentActivity;
          }
          return { ok: true };
        },
      },
      i18n: { getUILanguage: () => "en" },
      storage: {
        sync: {
          async get() { return { ...stored }; },
          async set(value) {
            writes.push({ ...value });
            await blockers.shift();
            stored = { ...value };
          },
        },
        local: {
          async get(key) {
            if (typeof key === "string") {
              return key in localStored ? { [key]: structuredClone(localStored[key]) } : {};
            }
            return structuredClone(localStored);
          },
        },
        onChanged: {
          addListener(listener) { storageListeners.push(listener); },
        },
      },
    },
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    await import(`../src/options/options.js?test=${crypto.randomUUID()}`);
    await waitUntil(() => get("settings-form").attributes["aria-busy"] === "false");
    await scenario({
      get, writes, timers, sentMessages,
      get stored() { return stored; },
      get localStored() { return localStored; },
      setLocal(next) {
        localStored = structuredClone(next);
        for (const listener of storageListeners) {
          listener({ saveHistory: {}, recentActivity: {} }, "local");
        }
      },
      fire(id, type, extra = {}) {
        return get(id).listeners[type]({ preventDefault() {}, target: get(id), ...extra });
      },
      blockNextSave() {
        let resolve, reject;
        blockers.push(new Promise((yes, no) => { resolve = yes; reject = no; }));
        return { resolve, reject };
      },
      flushDebounce() {
        for (const [id, timer] of [...timers]) {
          if (timer.delay === 240) { timers.delete(id); timer.callback(); }
        }
      },
    });
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("an older save cannot overwrite a newer debounced edit", async () => {
  await withOptions(async state => {
    const pending = state.blockNextSave();
    state.get("jpg-quality").value = "0.20";
    state.fire("jpg-quality", "input");
    state.flushDebounce();
    await waitUntil(() => state.writes.length === 1);
    state.get("jpg-quality").value = "0.80";
    state.fire("jpg-quality", "input");
    pending.resolve();
    await new Promise(setImmediate);
    assert.equal(state.get("jpg-quality").value, "0.80");
    state.flushDebounce();
    await waitUntil(() => state.stored.jpgQuality === 0.8);
    assert.deepEqual(state.writes.map(value => value.jpgQuality), [0.2, 0.8]);
  });
});

test("starting an older queued save does not cancel a newer debounce", async () => {
  await withOptions(async state => {
    const pending = state.blockNextSave();
    state.get("silent-save").checked = true;
    state.fire("silent-save", "change");
    await waitUntil(() => state.writes.length === 1);
    state.get("silent-save").checked = false;
    state.fire("silent-save", "change");
    state.get("webp-quality").value = "0.50";
    state.fire("webp-quality", "input");
    pending.resolve();
    await waitUntil(() => state.writes.length === 2);
    assert.equal([...state.timers.values()].filter(timer => timer.delay === 240).length, 1);
    state.flushDebounce();
    await waitUntil(() => state.stored.webpQuality === 0.5);
    assert.equal(state.stored.silentSave, false);
  });
});

test("edits made while restoring defaults remain the latest desired settings", async () => {
  await withOptions(async state => {
    const pending = state.blockNextSave();
    state.fire("reset-button", "click");
    await waitUntil(() => state.writes.length === 1);
    state.get("jpg-quality").value = "0.60";
    state.fire("jpg-quality", "input");
    pending.resolve();
    await waitUntil(() => state.get("reset-button").disabled === false);
    assert.equal(state.get("jpg-quality").value, "0.60");
    state.flushDebounce();
    await waitUntil(() => state.stored.jpgQuality === 0.6);
    assert.deepEqual(state.writes.map(value => value.jpgQuality), [0.92, 0.6]);
  });
});

test("failed persistence is visible and does not discard the next edit", async () => {
  await withOptions(async state => {
    const pending = state.blockNextSave();
    state.get("jpg-quality").value = "0.20";
    state.fire("jpg-quality", "input");
    state.flushDebounce();
    await waitUntil(() => state.writes.length === 1);
    state.get("jpg-quality").value = "0.70";
    state.fire("jpg-quality", "input");
    pending.reject(new Error("Storage unavailable"));
    await waitUntil(() => state.get("operation-status").dataset.kind === "error");
    assert.match(state.get("operation-status").textContent, /Storage unavailable/);
    state.flushDebounce();
    await waitUntil(() => state.stored.jpgQuality === 0.7);
  });
});

test("history dialog paginates both save history and recent activity and switches tabs", async () => {
  const saveHistory = Array.from({ length: 7 }, (_, index) => ({
    id: `h-${index + 1}`,
    status: "completed",
    action: "save",
    format: "png",
    finalPath: `C:\\Downloads\\item-${index + 1}.png`,
    finishedAt: "2026-11-23T09:00:00.000Z",
  }));
  const recentActivity = Array.from({ length: 12 }, (_, index) => ({
    id: `a-${index + 1}`,
    title: `Activity ${index + 1}`,
    message: `Detail ${index + 1}`,
    status: "success",
    createdAt: "2026-11-23T09:00:00.000Z",
  }));

  await withOptions(async (state) => {
    assert.equal(state.get("tab-history").attributes["aria-selected"], "true");
    assert.equal(state.get("tab-activity").attributes["aria-selected"], "false");
    assert.equal(state.get("history-panel").hidden, false);
    assert.equal(state.get("activity-panel").hidden, true);
    assert.equal(state.get("tab-history-count").textContent, "7");
    assert.equal(state.get("tab-activity-count").textContent, "12");

    assert.equal(state.get("history-list").children.length, 5);
    assert.equal(state.get("history-pagination").hidden, false);
    assert.equal(state.get("history-prev-button").disabled, true);
    assert.equal(state.get("history-next-button").disabled, false);

    state.fire("history-next-button", "click");
    assert.equal(state.get("history-list").children.length, 2);
    assert.equal(state.get("history-prev-button").disabled, false);
    assert.equal(state.get("history-next-button").disabled, true);

    state.fire("tab-activity", "click");
    assert.equal(state.get("tab-activity").attributes["aria-selected"], "true");
    assert.equal(state.get("activity-panel").hidden, false);
    assert.equal(state.get("history-panel").hidden, true);
    assert.equal(state.get("activity-list").children.length, 5);
    assert.equal(state.get("activity-pagination").hidden, false);
    assert.equal(state.get("activity-prev-button").disabled, true);
    assert.equal(state.get("activity-next-button").disabled, false);

    state.fire("activity-next-button", "click");
    assert.equal(state.get("activity-list").children.length, 5);
    state.fire("activity-next-button", "click");
    assert.equal(state.get("activity-list").children.length, 2);
    assert.equal(state.get("activity-next-button").disabled, true);

    state.setLocal({ saveHistory: saveHistory.slice(0, 3), recentActivity: recentActivity.slice(0, 4) });
    await waitUntil(() => state.get("tab-activity-count").textContent === "4");
    assert.equal(state.get("activity-list").children.length, 4);
    assert.equal(state.get("activity-pagination").hidden, true);
    assert.equal(state.get("history-list").children.length, 3);
    assert.equal(state.get("history-pagination").hidden, true);
  }, { local: { saveHistory, recentActivity } });
});

test("clearing history clears and re-renders both save history and recent activity", async () => {
  await withOptions(async (state) => {
    assert.equal(state.get("tab-history-count").textContent, "1");
    assert.equal(state.get("tab-activity-count").textContent, "1");

    state.fire("clear-history-button", "click");
    await waitUntil(() => state.get("tab-activity-count").textContent === "0");

    assert.deepEqual(state.sentMessages, [{ type: "CLEAR_SAVE_HISTORY" }]);
    assert.equal(state.get("tab-history-count").textContent, "0");
    assert.equal(state.get("tab-activity-count").textContent, "0");
    assert.equal(state.get("history-pagination").hidden, true);
    assert.equal(state.get("activity-pagination").hidden, true);
    assert.equal(state.get("history-list").children[0].className, "empty");
    assert.equal(state.get("activity-list").children[0].className, "empty");
  }, {
    local: {
      saveHistory: [{ id: "h-1", status: "completed", format: "png", finalPath: "a.png" }],
      recentActivity: [{ id: "a-1", title: "Saved", message: "Done", status: "success" }],
    },
  });
});
