import { normalizeLocaleOverride } from "./i18n.js";

const SUPPORTED_SCREENSHOT_FORMATS = new Set(["png", "jpg", "webp"]);

export const DEFAULT_SETTINGS = {
  jpgQuality: 0.92,
  webpQuality: 0.92,
  silentSave: false,
  copyPathAfterSave: true,
  defaultScreenshotFormat: "png",
  localeOverride: "auto"
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

export async function saveSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  await chrome.storage.sync.set(normalized);
  return normalized;
}

function normalizeSettings(rawSettings) {
  return {
    jpgQuality: clampQuality(rawSettings.jpgQuality, DEFAULT_SETTINGS.jpgQuality),
    webpQuality: clampQuality(rawSettings.webpQuality, DEFAULT_SETTINGS.webpQuality),
    silentSave: Boolean(rawSettings.silentSave),
    copyPathAfterSave:
      rawSettings.copyPathAfterSave === undefined ||
      rawSettings.copyPathAfterSave === null
        ? DEFAULT_SETTINGS.copyPathAfterSave
        : Boolean(rawSettings.copyPathAfterSave),
    defaultScreenshotFormat: normalizeScreenshotFormat(
      rawSettings.defaultScreenshotFormat
    ),
    localeOverride: normalizeLocaleOverride(rawSettings.localeOverride)
  };
}

function normalizeScreenshotFormat(value) {
  return typeof value === "string" && SUPPORTED_SCREENSHOT_FORMATS.has(value)
    ? value
    : DEFAULT_SETTINGS.defaultScreenshotFormat;
}

function clampQuality(value, fallback) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0.1, parsed));
}
