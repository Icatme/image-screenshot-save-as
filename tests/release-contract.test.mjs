import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

function placeholderNames(message) {
  return [...message.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)\$/g)]
    .map((match) => match[1].toLowerCase())
    .sort();
}

test("manifest is MV3 and has a valid Chrome extension version", async () => {
  const manifest = await readJson("manifest.json");
  const packageMetadata = await readJson("package.json");
  const packageLockMetadata = await readJson("package-lock.json");
  assert.equal(manifest.manifest_version, 3);
  assert.ok(
    Number(manifest.minimum_chrome_version.split(".")[0]) >= 116,
    "chrome.runtime.getContexts requires Chrome 116 or newer",
  );
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
  for (const part of manifest.version.split(".")) {
    assert.ok(Number(part) <= 65_535, `version component is too large: ${part}`);
    assert.ok(part === "0" || !part.startsWith("0"), `version component has a leading zero: ${part}`);
  }

  const npmVersionParts = manifest.version.split(".");
  assert.ok(npmVersionParts.length <= 3, "manifest version must map cleanly to package semver");
  while (npmVersionParts.length < 3) {
    npmVersionParts.push("0");
  }
  const expectedPackageVersion = npmVersionParts.join(".");
  assert.equal(packageMetadata.version, expectedPackageVersion);
  assert.equal(packageLockMetadata.version, expectedPackageVersion);
  assert.equal(packageLockMetadata.packages[""].version, expectedPackageVersion);
});

test("release source whitelist contains only the manifest runtime icons", async () => {
  const manifest = await readJson("manifest.json");
  const releaseCommon = await readFile(
    path.join(repositoryRoot, "scripts", "release-common.ps1"),
    "utf8",
  );
  const expectedIcons = Object.values(manifest.icons).sort();
  assert.deepEqual(expectedIcons, [
    "assets/icons/icon-128.png",
    "assets/icons/icon-16.png",
    "assets/icons/icon-32.png",
    "assets/icons/icon-48.png",
  ]);

  for (const iconPath of expectedIcons) {
    assert.match(releaseCommon, new RegExp(`"${iconPath.replaceAll("/", "\\/")}"`));
  }
  assert.doesNotMatch(releaseCommon, /"assets\/icons"/);
  assert.doesNotMatch(releaseCommon, /icon-(?:1024|source-cropped)\.png|source-icon\.svg/);
});

test("all locale catalogs have identical keys and placeholder contracts", async () => {
  const manifest = await readJson("manifest.json");
  const locales = (await readdir(path.join(repositoryRoot, "_locales"), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(locales.includes(manifest.default_locale));

  const catalogs = new Map();
  for (const locale of locales) {
    catalogs.set(locale, await readJson(path.join("_locales", locale, "messages.json")));
  }

  const base = catalogs.get(manifest.default_locale);
  const baseKeys = Object.keys(base).sort();
  for (const [locale, catalog] of catalogs) {
    assert.deepEqual(Object.keys(catalog).sort(), baseKeys, `${locale} message keys`);
    for (const key of baseKeys) {
      const expectedPlaceholders = Object.keys(base[key].placeholders ?? {})
        .map((name) => name.toLowerCase())
        .sort();
      const actualPlaceholders = Object.keys(catalog[key].placeholders ?? {})
        .map((name) => name.toLowerCase())
        .sort();
      assert.deepEqual(actualPlaceholders, expectedPlaceholders, `${locale}.${key} placeholder definitions`);
      assert.deepEqual(placeholderNames(catalog[key].message), expectedPlaceholders, `${locale}.${key} placeholder usage`);

      for (const placeholder of actualPlaceholders) {
        const expected = base[key].placeholders[placeholder].content;
        const actual = catalog[key].placeholders[placeholder].content;
        assert.match(actual, /^\$[1-9]\d*$/, `${locale}.${key}.${placeholder} content`);
        assert.equal(actual, expected, `${locale}.${key}.${placeholder} position`);
      }
    }
  }
});

test("every manifest localization token exists in the default catalog", async () => {
  const manifestText = await readFile(path.join(repositoryRoot, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const catalog = await readJson(path.join("_locales", manifest.default_locale, "messages.json"));
  const tokens = [...manifestText.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((match) => match[1]);
  for (const token of tokens) {
    assert.ok(catalog[token], `missing default locale message: ${token}`);
  }
});

test("system notification icons resolve from the extension root", async () => {
  const serviceWorker = await readFile(
    path.join(repositoryRoot, "src/background/service-worker.js"),
    "utf8",
  );
  assert.match(
    serviceWorker,
    /iconUrl:\s*chrome\.runtime\.getURL\("assets\/icons\/icon-128\.png"\)/,
  );
  assert.doesNotMatch(
    serviceWorker,
    /iconUrl:\s*"assets\/icons\/icon-128\.png"/,
  );
});
