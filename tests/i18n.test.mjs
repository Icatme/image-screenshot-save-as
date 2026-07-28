import assert from "node:assert/strict";
import test from "node:test";

import {
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
