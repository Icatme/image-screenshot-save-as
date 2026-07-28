import assert from "node:assert/strict";
import test from "node:test";

const writes = [];
globalThis.chrome = {
  storage: {
    sync: {
      async get() {
        return {
          jpgQuality: "not-a-number",
          webpQuality: 5,
          silentSave: 1,
          localeOverride: "fr",
        };
      },
      async set(value) {
        writes.push(value);
      },
    },
  },
};

const {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
} = await import("../src/lib/settings.js");

test("getSettings normalizes persisted values", async () => {
  assert.deepEqual(await getSettings(), {
    jpgQuality: DEFAULT_SETTINGS.jpgQuality,
    webpQuality: 1,
    silentSave: true,
    localeOverride: "auto",
  });
});

test("saveSettings clamps quality before storage", async () => {
  const result = await saveSettings({
    jpgQuality: 0,
    webpQuality: 0.333,
    silentSave: false,
    localeOverride: "de",
  });

  assert.deepEqual(result, {
    jpgQuality: 0.1,
    webpQuality: 0.333,
    silentSave: false,
    localeOverride: "de",
  });
  assert.deepEqual(writes.at(-1), result);
});
