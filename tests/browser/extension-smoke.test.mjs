import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function findChromeExecutable() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env.PROGRAMFILES ?? "", "Chromium/Application/chrome.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }

  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next documented system location.
    }
  }
  return null;
}

const chromeExecutable = await findChromeExecutable();
const explicitSkip = process.env.IMG_SAVE_AS_SKIP_BROWSER_SMOKE === "1";
const browserSmokeRequired =
  process.env.IMG_SAVE_AS_REQUIRE_BROWSER_SMOKE === "1";
if (browserSmokeRequired && explicitSkip) {
  throw new Error(
    "IMG_SAVE_AS_SKIP_BROWSER_SMOKE cannot be used when the browser smoke test is required",
  );
}
const skipReason = explicitSkip
  ? "IMG_SAVE_AS_SKIP_BROWSER_SMOKE=1 explicitly disables the real-Chrome smoke test"
  : chromeExecutable
    ? false
    : browserSmokeRequired
      ? false
    : "no Chrome/Chromium executable was found; set CHROME_PATH to run the smoke test";

test(
  "the unpacked extension loads in real Chrome and preserves WebP transparency",
  { skip: skipReason, timeout: 45_000 },
  async () => {
    assert.ok(
      chromeExecutable,
      "real-Chrome smoke test is required but no Chrome/Chromium executable was found",
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body style='height:2400px'>capture target</body></html>",
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    let browser;

    try {
      browser = await puppeteer.launch({
        browser: "chrome",
        executablePath: chromeExecutable,
        headless: true,
        pipe: true,
        enableExtensions: true,
      });
      const extensionId = await browser.installExtension(repositoryRoot);
      assert.match(extensionId, /^[a-p]{32}$/);

      const serviceWorkerTarget = await browser.waitForTarget(
        (target) =>
          target.type() === "service_worker" &&
          target.url() ===
            `chrome-extension://${extensionId}/src/background/service-worker.js`,
        { timeout: 10_000 },
      );
      const serviceWorker = await serviceWorkerTarget.worker();
      assert.ok(serviceWorker, "the MV3 service worker must start successfully");

      const notificationCheck = await serviceWorker.evaluate(async () => {
        const notificationId = `smoke-${crypto.randomUUID()}`;
        const iconUrl = chrome.runtime.getURL("assets/icons/icon-128.png");
        const createdId = await chrome.notifications.create(notificationId, {
          type: "basic",
          iconUrl,
          title: "Notification smoke test",
          message: "Verifies that the packaged icon resolves from the extension root.",
        });
        await chrome.notifications.clear(notificationId);
        return { createdId, iconUrl };
      });
      assert.match(notificationCheck.iconUrl, /^chrome-extension:\/\//);
      assert.equal(notificationCheck.createdId.startsWith("smoke-"), true);

      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.evaluateOnNewDocument(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          if (String(input).includes("/_locales/de/messages.json")) {
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
          return originalFetch(input, init);
        };
      });
      await page.goto(
        `chrome-extension://${extensionId}/src/options/options.html`,
        { waitUntil: "networkidle0" },
      );
      await page.waitForSelector("#settings-form");

      await page.select("#locale-override", "de");
      await page.select("#locale-override", "zh_CN");
      await page.waitForFunction(async () => {
        const stored = await chrome.storage.sync.get("localeOverride");
        return (
          stored.localeOverride === "zh_CN" &&
          document.documentElement.lang === "zh-CN" &&
          document.querySelector("#locale-override")?.value === "zh_CN"
        );
      });

      const backgroundResponse = await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: "CLEAR_SAVE_HISTORY" }),
      );
      assert.deepEqual(backgroundResponse, { ok: true });

      const recoveryCheck = await page.evaluate(async () => {
        const { preparePageForScreenshot, restorePageAfterScreenshot } =
          await import(chrome.runtime.getURL("src/lib/screenshot-page.js"));
        const scheduledRecoveries = [];
        const originalSetTimeout = window.setTimeout;
        window.setTimeout = (callback) => {
          scheduledRecoveries.push(callback);
          return scheduledRecoveries.length;
        };

        try {
          const firstState = preparePageForScreenshot(10_000);
          const markerDuringCapture = document.documentElement.hasAttribute(
            "data-img-save-as-capture-recovery",
          );
          restorePageAfterScreenshot(firstState);
          const secondState = preparePageForScreenshot(10_000);
          scheduledRecoveries[0]();
          const secondMarkerSurvivedFirstTimer =
            document.documentElement.hasAttribute(
              "data-img-save-as-capture-recovery",
            );
          restorePageAfterScreenshot(secondState);
          return {
            markerDuringCapture,
            secondMarkerSurvivedFirstTimer,
            markerAfterRestore: document.documentElement.hasAttribute(
              "data-img-save-as-capture-recovery",
            ),
          };
        } finally {
          window.setTimeout = originalSetTimeout;
        }
      });
      assert.deepEqual(recoveryCheck, {
        markerDuringCapture: true,
        secondMarkerSurvivedFirstTimer: true,
        markerAfterRestore: false,
      });

      const serverAddress = server.address();
      const injectedRecoveryCheck = await page.evaluate(
        async (targetUrl) => {
          const tab = await chrome.tabs.create({ url: targetUrl, active: true });
          try {
            while ((await chrome.tabs.get(tab.id)).status !== "complete") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }

            const { preparePageForScreenshot, restorePageAfterScreenshot } =
              await import(chrome.runtime.getURL("src/lib/screenshot-page.js"));
            const [prepared] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: preparePageForScreenshot,
              args: [10_000],
            });
            const [markerDuring] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () =>
                document.documentElement.hasAttribute(
                  "data-img-save-as-capture-recovery",
                ),
            });
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: restorePageAfterScreenshot,
              args: [prepared.result],
            });
            const [markerAfter] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () =>
                document.documentElement.hasAttribute(
                  "data-img-save-as-capture-recovery",
                ),
            });
            return {
              stateAvailable: Boolean(prepared.result?.viewportHeight),
              markerDuring: markerDuring.result,
              markerAfter: markerAfter.result,
            };
          } finally {
            await chrome.tabs.remove(tab.id);
          }
        },
        `http://127.0.0.1:${serverAddress.port}/capture`,
      );
      assert.deepEqual(injectedRecoveryCheck, {
        stateAvailable: true,
        markerDuring: true,
        markerAfter: false,
      });

      const result = await page.evaluate(async () => {
        const sourceCanvas = new OffscreenCanvas(2, 1);
        const sourceContext = sourceCanvas.getContext("2d", { alpha: true });
        sourceContext.clearRect(0, 0, 2, 1);
        sourceContext.fillStyle = "rgba(255, 0, 0, 1)";
        sourceContext.fillRect(1, 0, 1, 1);
        const sourceBlob = await sourceCanvas.convertToBlob({ type: "image/png" });

        const { convertImageBlob } = await import(
          chrome.runtime.getURL("src/lib/image-convert.js")
        );
        const converted = await convertImageBlob(sourceBlob, "webp", {
          jpgQuality: 0.92,
          webpQuality: 1,
        });

        const bitmap = await createImageBitmap(converted.blob);
        const inspectionCanvas = new OffscreenCanvas(2, 1);
        const inspectionContext = inspectionCanvas.getContext("2d", {
          alpha: true,
          willReadFrequently: true,
        });
        inspectionContext.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = [...inspectionContext.getImageData(0, 0, 2, 1).data];

        return {
          manifestVersion: chrome.runtime.getManifest().version,
          mimeType: converted.blob.type,
          pixels,
        };
      });

      assert.match(result.manifestVersion, /^\d+(?:\.\d+){0,3}$/);
      assert.equal(result.mimeType, "image/webp");
      assert.equal(result.pixels[3], 0, "the transparent pixel must keep alpha=0");
      assert.ok(result.pixels[7] >= 250, "the opaque pixel must remain opaque");
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
