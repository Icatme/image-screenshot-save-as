import assert from "node:assert/strict";
import test from "node:test";

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Settings operation did not finish");
    await new Promise(setImmediate);
  }
}

async function withOptions(scenario) {
  const elements = new Map();
  function element() {
    return {
      value: "", checked: false, dataset: {}, attributes: {}, listeners: {},
      childNodes: [{ textContent: "" }],
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector() { return { textContent: "" }; },
      append() {},
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const timers = new Map();
  const blockers = [];
  const writes = [];
  let timerId = 0;
  let stored = { jpgQuality: 0.92, webpQuality: 0.92, silentSave: false, localeOverride: "auto" };
  const globals = {
    document: { getElementById: get, createElement: element, documentElement: {} },
    window: {
      setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout(id) { timers.delete(id); },
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.9.0", manifest_version: 3 }),
        getURL: () => "data:application/json,%7B%7D",
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
        local: { async get() { return {}; } },
        onChanged: { addListener() {} },
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
      get, writes, timers,
      get stored() { return stored; },
      fire(id, type) { return get(id).listeners[type]({ preventDefault() {} }); },
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
