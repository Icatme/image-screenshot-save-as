import { normalizeLocaleOverride } from "./i18n.js";

export const DEFAULT_SETTINGS = {
  jpgQuality: 0.92,
  webpQuality: 0.92,
  silentSave: false,
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
    localeOverride: normalizeLocaleOverride(rawSettings.localeOverride)
  };
}

function clampQuality(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0.1, parsed));
}
