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
  "the unpacked extension handles trusted region input and preserves WebP transparency",
  { skip: skipReason, timeout: 45_000 },
  async () => {
    assert.ok(
      chromeExecutable,
      "real-Chrome smoke test is required but no Chrome/Chromium executable was found",
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; }
      body { min-height: 2400px; }
      dialog:not(#page-dialog) {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: scale(0.1) !important;
      }
      #capture-target {
        position: fixed;
        left: 20px;
        top: 30px;
        width: 100px;
        height: 70px;
        background: rgb(12, 200, 80);
      }
      #page-dialog {
        position: fixed;
        left: 240px;
        top: 160px;
        width: 320px;
        height: 220px;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <div id="img-save-as-region-selector" data-page-owned-region-selector hidden>Page-owned element</div>
    <div id="capture-target"></div>
    <dialog id="page-dialog"><button autofocus>Page modal</button></dialog>
    <script>
      window.captureEventCounts = {
        auxclick: 0,
        click: 0,
        contextmenu: 0,
        keydown: 0,
        keyup: 0,
      };
      for (const eventName of Object.keys(window.captureEventCounts)) {
        window.addEventListener(eventName, () => {
          window.captureEventCounts[eventName] += 1;
        });
      }
      window.capturePointerBlockerCounts = {
        pointerdown: 0,
        pointermove: 0,
        pointerup: 0,
      };
      for (const eventName of Object.keys(window.capturePointerBlockerCounts)) {
        window.addEventListener(eventName, (event) => {
          window.capturePointerBlockerCounts[eventName] += 1;
          event.stopPropagation();
        }, true);
      }
      document.getElementById("page-dialog").showModal();
    </script>
  </body>
</html>`);
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

      await page.evaluate(async () => {
        await chrome.storage.local.set({
          saveHistory: [
            {
              id: "partial-ui-smoke",
              status: "completed",
              action: "save",
              format: "png",
              requestedPath: "page-full-page-screenshot-partial.png",
              finalPath: "C:\\Downloads\\page-full-page-screenshot-partial.png",
              captureType: "screenshot",
              screenshotMode: "full-page",
              partialCapture: true,
              partialReason: "scroll_stalled",
              capturedHeight: 100,
              totalHeight: 120,
              finishedAt: new Date().toISOString(),
            },
          ],
          recentActivity: [
            {
              id: "partial-ui-smoke",
              title: "部分长截图已保存",
              message: "已保存捕获到的内容。",
              status: "warning",
              createdAt: new Date().toISOString(),
            },
          ],
        });
      });
      await page.waitForFunction(() => {
        return (
          document.querySelector("#history-list .list-item")?.dataset.status ===
            "warning" &&
          document.querySelector("#activity-list .list-item")?.dataset.status ===
            "warning"
        );
      });
      const partialFeedbackCheck = await page.evaluate(() => ({
        historyStatus:
          document.querySelector("#history-list .list-item")?.dataset.status,
        historyMeta:
          document.querySelector("#history-list .list-meta")?.textContent,
        activityStatus:
          document.querySelector("#activity-list .list-item")?.dataset.status,
      }));
      assert.equal(partialFeedbackCheck.historyStatus, "warning");
      assert.equal(partialFeedbackCheck.activityStatus, "warning");
      assert.match(partialFeedbackCheck.historyMeta, /页面无法继续滚动/);
      assert.match(partialFeedbackCheck.historyMeta, /100 \/ 120/);

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
          preparePageForScreenshot(10_000);
          const markerDuringCapture = document.documentElement.hasAttribute(
            "data-img-save-as-capture-recovery",
          );
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

      const screenshotPageGeometryCheck = await page.evaluate(async () => {
        const {
          isPagePreparedForScreenshot,
          preparePageForScreenshot,
          restorePageAfterScreenshot,
          scrollPageForScreenshot,
        } = await import(
          chrome.runtime.getURL("src/lib/screenshot-page.js")
        );
        const root = document.documentElement;
        const body = document.body;
        const detachedContents = document.createDocumentFragment();
        detachedContents.append(...Array.from(body.childNodes));
        const originalRootStyle = root.getAttribute("style");
        const originalBodyStyle = body.getAttribute("style");
        const originalScrollX = window.scrollX;
        const originalScrollY = window.scrollY;

        const waitForLayout = () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        const restoreStyle = (element, value) => {
          if (value === null) {
            element.removeAttribute("style");
          } else {
            element.setAttribute("style", value);
          }
        };

        let activeState;
        try {
          root.style.cssText =
            "height:auto!important;min-height:0!important;overflow:auto!important;";
          body.style.cssText =
            "display:block!important;height:auto!important;min-height:0!important;" +
            "margin:0!important;padding:0!important;overflow:visible!important;";

          const fractionalFixture = document.createElement("div");
          fractionalFixture.style.cssText = "width:1px;height:8845.5px;";
          body.replaceChildren(fractionalFixture);
          await waitForLayout();

          window.scrollTo(0, 173);
          await waitForLayout();
          const initialScrollY = window.scrollY;
          const scrollingElement = document.scrollingElement;
          const rootScrollHeight = scrollingElement.scrollHeight;
          const rootRectHeight =
            scrollingElement.getBoundingClientRect().height;
          const viewportHeight = window.innerHeight;

          window.scrollTo(0, Number.MAX_SAFE_INTEGER);
          await waitForLayout();
          const actualMaxScrollY = window.scrollY;
          window.scrollTo(0, initialScrollY);
          await waitForLayout();

          activeState = preparePageForScreenshot(10_000);
          const preparedScrollY = window.scrollY;
          const fractionalState = {
            scrollTarget: activeState.scrollTarget,
            pageHeight: activeState.pageHeight,
            maxScrollY: activeState.maxScrollY,
          };
          const endpoint = await scrollPageForScreenshot(
            activeState,
            activeState.maxScrollY,
          );
          const reachedScrollY = window.scrollY;
          const fractionalRestored = restorePageAfterScreenshot(activeState);
          activeState = null;
          const restoredScrollY = window.scrollY;

          root.style.cssText =
            "height:100%!important;min-height:0!important;overflow:hidden!important;";
          body.style.cssText =
            "display:block!important;height:100%!important;min-height:0!important;" +
            "margin:0!important;padding:0!important;overflow:hidden!important;";

          const clippingHost = document.createElement("div");
          const clippedScroller = document.createElement("div");
          const clippedHeight = Math.max(240, Math.floor(window.innerHeight * 0.8));
          const clippingHeight = Math.max(
            180,
            Math.floor(window.innerHeight * 0.55),
          );
          clippingHost.style.cssText =
            `position:fixed;left:0;top:0;width:80vw;height:${clippingHeight}px;` +
            "overflow:hidden;";
          clippedScroller.style.cssText =
            `width:100%;height:${clippedHeight}px;overflow-y:auto;`;
          const clippedContent = document.createElement("div");
          clippedContent.style.height = `${clippedHeight * 3}px`;
          clippedScroller.append(clippedContent);
          clippingHost.append(clippedScroller);
          body.replaceChildren(clippingHost);
          clippedScroller.scrollTop = 123;
          await waitForLayout();

          const clippedRect = clippedScroller.getBoundingClientRect();
          const clippingRect = clippingHost.getBoundingClientRect();
          const clippedVisibleHeight =
            Math.min(window.innerHeight, clippingRect.bottom, clippedRect.bottom) -
            Math.max(0, clippingRect.top, clippedRect.top);
          activeState = preparePageForScreenshot(10_000);
          const clippedState = {
            scrollTarget: activeState.scrollTarget,
            maxScrollY: activeState.maxScrollY,
          };
          const clippedScrollTopDuringCapture = clippedScroller.scrollTop;
          const clippedRestored = restorePageAfterScreenshot(activeState);
          activeState = null;
          const clippedElementMetrics = {
            clientHeight: clippedScroller.clientHeight,
            visibleHeight: clippedVisibleHeight,
            scrollHeight: clippedScroller.scrollHeight,
            rectTop: clippedRect.top,
            rectBottom: clippedRect.bottom,
            viewportHeight: window.innerHeight,
            visibleWidth:
              Math.min(window.innerWidth, clippedRect.right) -
              Math.max(0, clippedRect.left),
            viewportWidth: window.innerWidth,
            scrollTopDuringCapture: clippedScrollTopDuringCapture,
            restored: clippedRestored,
            state: clippedState,
          };

          const transformedScroller = document.createElement("div");
          const transformedHeight = Math.max(
            240,
            Math.floor(window.innerHeight * 0.7),
          );
          transformedScroller.style.cssText =
            `position:fixed;left:0;top:0;width:80vw;height:${transformedHeight}px;` +
            "overflow-y:auto;transform:scaleY(0.75);transform-origin:top left;";
          const transformedContent = document.createElement("div");
          transformedContent.style.height = `${transformedHeight * 3}px`;
          transformedScroller.append(transformedContent);
          body.replaceChildren(transformedScroller);
          transformedScroller.scrollTop = 117;
          await waitForLayout();

          const transformedRect = transformedScroller.getBoundingClientRect();
          activeState = preparePageForScreenshot(10_000);
          const transformedState = {
            scrollTarget: activeState.scrollTarget,
            maxScrollY: activeState.maxScrollY,
          };
          const transformedScrollTopDuringCapture = transformedScroller.scrollTop;
          const transformedRestored = restorePageAfterScreenshot(activeState);
          activeState = null;
          const transformedElementMetrics = {
            clientHeight: transformedScroller.clientHeight,
            rectHeight: transformedRect.height,
            scrollHeight: transformedScroller.scrollHeight,
            viewportHeight: window.innerHeight,
            scrollTopDuringCapture: transformedScrollTopDuringCapture,
            restored: transformedRestored,
            state: transformedState,
          };

          const snapScroller = document.createElement("div");
          const snapHeight = Math.max(
            240,
            Math.floor(window.innerHeight * 0.7),
          );
          snapScroller.style.cssText =
            `position:fixed;left:0;top:0;width:80vw;height:${snapHeight}px;` +
            "overflow-y:auto;scroll-snap-type:y mandatory;";
          for (let index = 0; index < 4; index += 1) {
            const snapSection = document.createElement("div");
            snapSection.style.cssText =
              `height:${snapHeight}px;scroll-snap-align:start;`;
            snapScroller.append(snapSection);
          }
          body.replaceChildren(snapScroller);
          snapScroller.scrollTop = snapHeight;
          await waitForLayout();

          activeState = preparePageForScreenshot(10_000);
          const snapState = {
            scrollTarget: activeState.scrollTarget,
            originalScrollSnapType: activeState.originalTargetScrollSnapType,
            originalScrollSnapPriority:
              activeState.originalTargetScrollSnapPriority,
          };
          const snapTypeDuringCapture =
            snapScroller.style.getPropertyValue("scroll-snap-type");
          const snapPriorityDuringCapture =
            snapScroller.style.getPropertyPriority("scroll-snap-type");
          const snapEndpoint = await scrollPageForScreenshot(activeState, 137);
          const snapRestored = restorePageAfterScreenshot(activeState);
          activeState = null;
          const snapTypeAfterRestore =
            snapScroller.style.getPropertyValue("scroll-snap-type");
          const snapPriorityAfterRestore =
            snapScroller.style.getPropertyPriority("scroll-snap-type");

          activeState = preparePageForScreenshot(10_000);
          snapScroller.remove();
          const missingTargetPrepared = isPagePreparedForScreenshot(activeState);
          const missingTargetEndpoint = await scrollPageForScreenshot(
            activeState,
            137,
          );
          const missingTargetRestored = restorePageAfterScreenshot(activeState);
          activeState = null;

          return {
            fractional: {
              rootScrollHeight,
              rootRectHeight,
              viewportHeight,
              actualMaxScrollY,
              initialScrollY,
              preparedScrollY,
              endpoint,
              reachedScrollY,
              restoredScrollY,
              restored: fractionalRestored,
              state: fractionalState,
            },
            clippedElement: clippedElementMetrics,
            transformedElement: transformedElementMetrics,
            snapElement: {
              state: snapState,
              snapTypeDuringCapture,
              snapPriorityDuringCapture,
              endpoint: snapEndpoint,
              restored: snapRestored,
              snapTypeAfterRestore,
              snapPriorityAfterRestore,
              missingTargetPrepared,
              missingTargetEndpoint,
              missingTargetRestored,
            },
          };
        } finally {
          if (activeState) {
            restorePageAfterScreenshot(activeState);
          }
          body.replaceChildren(detachedContents);
          restoreStyle(root, originalRootStyle);
          restoreStyle(body, originalBodyStyle);
          window.scrollTo(originalScrollX, originalScrollY);
        }
      });

      const fractional = screenshotPageGeometryCheck.fractional;
      assert.equal(fractional.rootRectHeight, 8845.5);
      assert.notEqual(
        fractional.rootRectHeight,
        Math.round(fractional.rootRectHeight),
        "the fixture must expose a real fractional root rect",
      );
      assert.equal(fractional.rootScrollHeight, 8846);
      assert.equal(
        fractional.actualMaxScrollY,
        fractional.rootScrollHeight - fractional.viewportHeight,
      );
      assert.equal(fractional.state.scrollTarget, "window");
      assert.equal(fractional.state.pageHeight, fractional.rootScrollHeight);
      assert.equal(fractional.state.maxScrollY, fractional.actualMaxScrollY);
      assert.equal(fractional.preparedScrollY, 0);
      assert.equal(fractional.endpoint.documentChanged, undefined);
      assert.equal(fractional.endpoint.scrollY, fractional.actualMaxScrollY);
      assert.equal(fractional.reachedScrollY, fractional.actualMaxScrollY);
      assert.equal(fractional.restoredScrollY, fractional.initialScrollY);
      assert.equal(fractional.restored, true);

      const clippedElement = screenshotPageGeometryCheck.clippedElement;
      assert.ok(clippedElement.scrollHeight > clippedElement.clientHeight + 16);
      assert.ok(clippedElement.clientHeight > clippedElement.visibleHeight);
      assert.ok(clippedElement.rectTop >= 0);
      assert.ok(clippedElement.rectBottom <= clippedElement.viewportHeight);
      assert.ok(
        clippedElement.visibleHeight >= clippedElement.viewportHeight * 0.35,
        "the clipped scroller must otherwise satisfy the height heuristic",
      );
      assert.ok(
        clippedElement.visibleWidth >= clippedElement.viewportWidth * 0.45,
        "the clipped scroller must otherwise satisfy the width heuristic",
      );
      assert.equal(clippedElement.state.scrollTarget, "window");
      assert.equal(clippedElement.state.maxScrollY, 0);
      assert.equal(clippedElement.scrollTopDuringCapture, 123);
      assert.equal(clippedElement.restored, true);

      const transformedElement = screenshotPageGeometryCheck.transformedElement;
      assert.ok(
        transformedElement.scrollHeight > transformedElement.clientHeight + 16,
      );
      assert.ok(transformedElement.rectHeight < transformedElement.clientHeight);
      assert.ok(
        transformedElement.rectHeight >= transformedElement.viewportHeight * 0.35,
        "the transformed scroller must otherwise satisfy the height heuristic",
      );
      assert.equal(transformedElement.state.scrollTarget, "window");
      assert.equal(transformedElement.state.maxScrollY, 0);
      assert.equal(transformedElement.scrollTopDuringCapture, 117);
      assert.equal(transformedElement.restored, true);

      const snapElement = screenshotPageGeometryCheck.snapElement;
      assert.equal(snapElement.state.scrollTarget, "element");
      assert.equal(snapElement.state.originalScrollSnapType, "y mandatory");
      assert.equal(snapElement.state.originalScrollSnapPriority, "");
      assert.equal(snapElement.snapTypeDuringCapture, "none");
      assert.equal(snapElement.snapPriorityDuringCapture, "important");
      assert.equal(snapElement.endpoint.documentChanged, undefined);
      assert.equal(snapElement.endpoint.scrollY, 137);
      assert.equal(snapElement.restored, true);
      assert.equal(snapElement.snapTypeAfterRestore, "y mandatory");
      assert.equal(snapElement.snapPriorityAfterRestore, "");
      assert.equal(snapElement.missingTargetPrepared, false);
      assert.deepEqual(snapElement.missingTargetEndpoint, {
        documentChanged: true,
      });
      assert.equal(snapElement.missingTargetRestored, true);

      const serverAddress = server.address();
      const targetUrl = `http://127.0.0.1:${serverAddress.port}/capture`;
      const injectedRecoveryCheck = await page.evaluate(
        async (targetUrl) => {
          const tab = await chrome.tabs.create({ url: targetUrl, active: true });
          while ((await chrome.tabs.get(tab.id)).status !== "complete") {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          const { preparePageForScreenshot, restorePageAfterScreenshot } =
            await import(chrome.runtime.getURL("src/lib/screenshot-page.js"));
          const { selectScreenshotRegion } = await import(
            chrome.runtime.getURL("src/lib/screenshot-region.js")
          );
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

          window.regionSelectionPromise = chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: selectScreenshotRegion,
            args: [{ instruction: "Select a region" }, 10_000],
          });
          window.regionSelectionTabId = tab.id;
          return {
            tabId: tab.id,
            stateAvailable: Boolean(prepared.result?.viewportHeight),
            markerDuring: markerDuring.result,
            markerAfter: markerAfter.result,
          };
        },
        targetUrl,
      );
      assert.ok(Number.isInteger(injectedRecoveryCheck.tabId));
      assert.deepEqual(
        {
          stateAvailable: injectedRecoveryCheck.stateAvailable,
          markerDuring: injectedRecoveryCheck.markerDuring,
          markerAfter: injectedRecoveryCheck.markerAfter,
        },
        {
          stateAvailable: true,
          markerDuring: true,
          markerAfter: false,
        },
      );

      const capturePage = await browser.waitForTarget(
        (target) => target.type() === "page" && target.url() === targetUrl,
        { timeout: 10_000 },
      ).then((target) => target.page());
      assert.ok(capturePage, "the capture target tab must be available");
      capturePage.on("pageerror", (error) => pageErrors.push(error.message));
      await capturePage.bringToFront();
      await capturePage.waitForSelector(
        'dialog[id^="img-save-as-region-selector"]',
      );

      const topLayerCheck = await capturePage.evaluate(() => {
        const overlay = document.querySelector(
          'dialog[id^="img-save-as-region-selector"]',
        );
        const pageOwnedElement = document.querySelector(
          "[data-page-owned-region-selector]",
        );
        const pageDialog = document.getElementById("page-dialog");
        return {
          overlayIsDialog: overlay instanceof HTMLDialogElement,
          overlayIsTopmost: document.elementFromPoint(320, 220) === overlay,
          overlayAvoidedIdCollision: overlay?.id !== pageOwnedElement?.id,
          pageOwnedElementSurvived: Boolean(pageOwnedElement?.isConnected),
          pageDialogIsModal: pageDialog.matches(":modal"),
        };
      });
      assert.deepEqual(topLayerCheck, {
        overlayIsDialog: true,
        overlayIsTopmost: true,
        overlayAvoidedIdCollision: true,
        pageOwnedElementSurvived: true,
        pageDialogIsModal: true,
      });

      await capturePage.evaluate(() => window.scrollTo(0, 0));
      await capturePage.keyboard.press("ArrowDown");
      await capturePage.keyboard.press("PageDown");
      await capturePage.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      assert.deepEqual(
        await capturePage.evaluate(() => ({
          keydown: window.captureEventCounts.keydown,
          keyup: window.captureEventCounts.keyup,
          scrollY: window.scrollY,
        })),
        { keydown: 0, keyup: 0, scrollY: 0 },
      );

      await capturePage.mouse.click(320, 220, { button: "right" });
      const rightClickResult = await page.evaluate(async () => {
        const [selection] = await window.regionSelectionPromise;
        delete window.regionSelectionPromise;
        return selection.result;
      });
      assert.deepEqual(rightClickResult, { cancelled: true });
      assert.deepEqual(
        await capturePage.evaluate(() => ({
          auxclick: window.captureEventCounts.auxclick,
          contextmenu: window.captureEventCounts.contextmenu,
          overlayExists: Boolean(
            document.querySelector(
              'dialog[id^="img-save-as-region-selector"]',
            ),
          ),
          pageOwnedElementExists: Boolean(
            document.querySelector("[data-page-owned-region-selector]"),
          ),
        })),
        {
          auxclick: 0,
          contextmenu: 0,
          overlayExists: false,
          pageOwnedElementExists: true,
        },
      );

      const captureSession = await capturePage.createCDPSession();
      await captureSession.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: 2,
      });
      await capturePage.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const zoomedViewport = await capturePage.evaluate(() => ({
        width: visualViewport.width,
        height: visualViewport.height,
        scale: visualViewport.scale,
      }));
      assert.equal(zoomedViewport.scale, 2);

      await page.evaluate(async () => {
        const { selectScreenshotRegion } = await import(
          chrome.runtime.getURL("src/lib/screenshot-region.js")
        );
        window.regionSelectionPromise = chrome.scripting.executeScript({
          target: { tabId: window.regionSelectionTabId },
          func: selectScreenshotRegion,
          args: [{ instruction: "Select a region" }, 10_000],
        });
      });
      await capturePage.evaluate(() => {
        document.getElementById("page-dialog").close();
      });
      await capturePage.waitForSelector(
        'dialog[id^="img-save-as-region-selector"]',
      );
      await capturePage.mouse.move(20, 30);
      await capturePage.mouse.down();
      await capturePage.mouse.move(120, 100);
      await capturePage.mouse.up();

      const selectedRegion = await page.evaluate(async () => {
        const [selection] = await window.regionSelectionPromise;
        delete window.regionSelectionPromise;
        return selection.result;
      });
      assert.deepEqual(
        {
          x: selectedRegion.x,
          y: selectedRegion.y,
          width: selectedRegion.width,
          height: selectedRegion.height,
          viewportWidth: selectedRegion.viewportWidth,
          viewportHeight: selectedRegion.viewportHeight,
        },
        {
          x: 20,
          y: 30,
          width: 100,
          height: 70,
          viewportWidth: zoomedViewport.width,
          viewportHeight: zoomedViewport.height,
        },
      );
      const pointerBlockerCounts = await capturePage.evaluate(
        () => window.capturePointerBlockerCounts,
      );
      assert.ok(pointerBlockerCounts.pointerdown >= 2);
      assert.ok(pointerBlockerCounts.pointermove >= 1);
      assert.ok(pointerBlockerCounts.pointerup >= 2);
      assert.deepEqual(
        await capturePage.evaluate(() => ({
          click: window.captureEventCounts.click,
          overlayExists: Boolean(
            document.querySelector(
              'dialog[id^="img-save-as-region-selector"]',
            ),
          ),
          pageOwnedElementExists: Boolean(
            document.querySelector("[data-page-owned-region-selector]"),
          ),
        })),
        { click: 0, overlayExists: false, pageOwnedElementExists: true },
      );

      const capturedPng = await capturePage.screenshot({
        type: "png",
        encoding: "base64",
      });
      const cropCheck = await page.evaluate(
        async ({ dataUrl, region }) => {
          const bitmap = await createImageBitmap(
            await (await fetch(dataUrl)).blob(),
          );
          try {
            const { getScreenshotRegionPixels } = await import(
              chrome.runtime.getURL("src/lib/screenshot-region.js")
            );
            const source = getScreenshotRegionPixels(
              region,
              bitmap.width,
              bitmap.height,
            );
            const canvas = new OffscreenCanvas(source.width, source.height);
            const context = canvas.getContext("2d", {
              alpha: true,
              willReadFrequently: true,
            });
            context.drawImage(
              bitmap,
              source.x,
              source.y,
              source.width,
              source.height,
              0,
              0,
              source.width,
              source.height,
            );
            const pixelAt = (x, y) => [
              ...context.getImageData(x, y, 1, 1).data,
            ];
            const sampledPixels = [
              pixelAt(1, 1),
              pixelAt(source.width - 2, 1),
              pixelAt(1, source.height - 2),
              pixelAt(source.width - 2, source.height - 2),
              pixelAt(
                Math.floor(source.width / 2),
                Math.floor(source.height / 2),
              ),
            ];
            const blob = await canvas.convertToBlob({ type: "image/png" });
            return {
              width: source.width,
              height: source.height,
              mimeType: blob.type,
              sampledPixels,
            };
          } finally {
            bitmap.close();
          }
        },
        {
          dataUrl: `data:image/png;base64,${capturedPng}`,
          region: selectedRegion,
        },
      );
      assert.deepEqual(cropCheck, {
        width: 200,
        height: 140,
        mimeType: "image/png",
        sampledPixels: Array.from(
          { length: 5 },
          () => [12, 200, 80, 255],
        ),
      });

      await captureSession.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: 1,
      });
      await captureSession.detach();

      await page.evaluate(async () => {
        const { selectScreenshotRegion } = await import(
          chrome.runtime.getURL("src/lib/screenshot-region.js")
        );
        window.regionSelectionPromise = chrome.scripting.executeScript({
          target: { tabId: window.regionSelectionTabId },
          func: selectScreenshotRegion,
          args: [{ instruction: "Select a region" }, 10_000],
        });
      });
      await capturePage.waitForSelector(
        'dialog[id^="img-save-as-region-selector"]',
      );
      await capturePage.keyboard.press("Escape");
      const escapeResult = await page.evaluate(async () => {
        const [selection] = await window.regionSelectionPromise;
        delete window.regionSelectionPromise;
        return selection.result;
      });
      assert.deepEqual(escapeResult, { cancelled: true });
      assert.deepEqual(
        await capturePage.evaluate(() => ({
          keydown: window.captureEventCounts.keydown,
          keyup: window.captureEventCounts.keyup,
          overlayExists: Boolean(
            document.querySelector(
              'dialog[id^="img-save-as-region-selector"]',
            ),
          ),
          pageOwnedElementExists: Boolean(
            document.querySelector("[data-page-owned-region-selector]"),
          ),
        })),
        {
          keydown: 0,
          keyup: 0,
          overlayExists: false,
          pageOwnedElementExists: true,
        },
      );

      await page.evaluate(async () => {
        await chrome.tabs.remove(window.regionSelectionTabId);
        delete window.regionSelectionTabId;
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
