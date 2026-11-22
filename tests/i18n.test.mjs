import assert from "node:assert/strict";
import test from "node:test";

import {
  getTranslator,
  normalizeLocaleOverride,
  resolveLocale,
} from "../src/lib/i18n.js";

test("normalizeLocaleOverride accepts only supported explicit locales", () => {
  assert.equal(normalizeLocaleOverride("zh_TW"), "zh_TW");
  assert.equal(normalizeLocaleOverride("auto"), "auto");
  assert.equal(normalizeLocaleOverride("fr"), "auto");
  assert.equal(normalizeLocaleOverride(null), "auto");
});

test("resolveLocale maps browser locale families", () => {
  assert.equal(resolveLocale("auto", "zh-HK"), "zh_TW");
  assert.equal(resolveLocale("auto", "zh-CN"), "zh_CN");
  assert.equal(resolveLocale("auto", "es-MX"), "es");
  assert.equal(resolveLocale("auto", "de-AT"), "de");
  assert.equal(resolveLocale("auto", "fr-FR"), "en");
});

test("resolveLocale gives an explicit supported override precedence", () => {
  assert.equal(resolveLocale("de", "zh-CN"), "de");
});

test("getTranslator retries failed catalog loads and preserves literal dollar characters", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  let attempts = 0;

  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    i18n: {
      getUILanguage: () => "en",
    },
  };
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { ok: false, status: 500 };
    }
    return {
      ok: true,
      async json() {
        return {
          savedInDir: {
            message: "Saved $COUNT$ in $DIRECTORY$.",
            placeholders: {
              count: { content: "$1" },
              directory: { content: "$2" },
            },
          },
          positional: {
            message: "First $1 then $2.",
          },
        };
      },
    };
  };

  try {
    const fresh = await import(`../src/lib/i18n.js?test=${crypto.randomUUID()}`);
    await assert.rejects(fresh.getTranslator("en"), /Failed to load locale catalog/);
    const translator = await fresh.getTranslator("en");
    assert.equal(attempts, 2);
    assert.equal(
      translator.t("savedInDir", ["$DIRECTORY$", "C:\\$backup\\$$&"]),
      "Saved $DIRECTORY$ in C:\\$backup\\$$&.",
    );
    assert.equal(
      translator.t("positional", ["$2", "$&"]),
      "First $2 then $&.",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});
