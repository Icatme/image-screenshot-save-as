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
          defaultScreenshotFormat: "bmp",
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
    copyPathAfterSave: true,
    defaultScreenshotFormat: "png",
    localeOverride: "auto",
  });
});

test("saveSettings clamps quality before storage", async () => {
  const result = await saveSettings({
    jpgQuality: 0,
    webpQuality: 0.333,
    silentSave: false,
    copyPathAfterSave: false,
    defaultScreenshotFormat: "webp",
    localeOverride: "de",
  });

  assert.deepEqual(result, {
    jpgQuality: 0.1,
    webpQuality: 0.333,
    silentSave: false,
    copyPathAfterSave: false,
    defaultScreenshotFormat: "webp",
    localeOverride: "de",
  });
  assert.deepEqual(writes.at(-1), result);
});

test("saveSettings falls back to default quality, copyPathAfterSave, and screenshot format for empty, null, or invalid inputs", async () => {
  const result = await saveSettings({
    jpgQuality: "",
    webpQuality: null,
    silentSave: false,
    copyPathAfterSave: null,
    defaultScreenshotFormat: "gif",
    localeOverride: "auto",
  });

  assert.equal(result.jpgQuality, DEFAULT_SETTINGS.jpgQuality);
  assert.equal(result.webpQuality, DEFAULT_SETTINGS.webpQuality);
  assert.equal(result.copyPathAfterSave, true);
  assert.equal(result.defaultScreenshotFormat, "png");

  const booleanResult = await saveSettings({
    jpgQuality: false,
    webpQuality: true,
    silentSave: false,
    copyPathAfterSave: false,
    defaultScreenshotFormat: "jpg",
    localeOverride: "auto",
  });

  assert.equal(booleanResult.jpgQuality, DEFAULT_SETTINGS.jpgQuality);
  assert.equal(booleanResult.webpQuality, DEFAULT_SETTINGS.webpQuality);
  assert.equal(booleanResult.copyPathAfterSave, false);
  assert.equal(booleanResult.defaultScreenshotFormat, "jpg");
});
