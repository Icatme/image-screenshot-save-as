const DEFAULT_LOCALE = "en";
const SUPPORTED_LOCALES = ["en", "zh_CN", "zh_TW", "es", "de"];
const catalogCache = new Map();

export { DEFAULT_LOCALE, SUPPORTED_LOCALES };

export function normalizeLocaleOverride(value) {
  if (typeof value !== "string") {
    return "auto";
  }

  if (value === "auto") {
    return value;
  }

  return SUPPORTED_LOCALES.includes(value) ? value : "auto";
}

export function resolveLocale(localeOverride = "auto", uiLanguage = getUiLanguage()) {
  const normalizedOverride = normalizeLocaleOverride(localeOverride);
  if (normalizedOverride !== "auto") {
    return normalizedOverride;
  }

  const normalizedUi = String(uiLanguage || "").replace("-", "_");
  const lowerUi = normalizedUi.toLowerCase();

  if (lowerUi.startsWith("zh_tw") || lowerUi.startsWith("zh_hk") || lowerUi.startsWith("zh_mo")) {
    return "zh_TW";
  }

  if (lowerUi.startsWith("zh")) {
    return "zh_CN";
  }

  if (lowerUi.startsWith("es")) {
    return "es";
  }

  if (lowerUi.startsWith("de")) {
    return "de";
  }

  if (lowerUi.startsWith("en")) {
    return "en";
  }

  return DEFAULT_LOCALE;
}

export async function getTranslator(localeOverride = "auto") {
  const locale = resolveLocale(localeOverride);
  const catalog = await getCatalog(locale);

  return {
    locale,
    t(messageName, substitutions) {
      const entry = catalog[messageName];
      if (!entry?.message) {
        return messageName;
      }

      return applySubstitutions(entry.message, entry.placeholders, substitutions);
    }
  };
}

function getUiLanguage() {
  if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
    return chrome.i18n.getUILanguage();
  }

  if (typeof navigator !== "undefined") {
    return navigator.language;
  }

  return DEFAULT_LOCALE;
}

async function getCatalog(locale) {
  if (!catalogCache.has(locale)) {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
    const promise = fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load locale catalog: ${locale}`);
      }

      return response.json();
    });

    catalogCache.set(locale, promise);
  }

  return catalogCache.get(locale);
}

function applySubstitutions(message, placeholders, substitutions) {
  if (substitutions == null) {
    return message;
  }

  const values = Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)];

  if (!placeholders) {
    return values.reduce((result, value, index) => result.replace(`$${index + 1}`, value), message);
  }

  let output = message;
  for (const [name, config] of Object.entries(placeholders)) {
    const match = /^\$(\d+)$/.exec(config.content || "");
    if (!match) {
      continue;
    }

    const value = values[Number(match[1]) - 1] ?? "";
    output = output.replaceAll(`$${name.toUpperCase()}$`, value);
  }

  return output;
}
