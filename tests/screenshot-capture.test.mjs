import assert from "node:assert/strict";
import test from "node:test";

import {
  ScreenshotPaginationRequired,
  captureScreenshotFrames,
} from "../src/lib/screenshot-capture.js";

const previousCanvas = globalThis.OffscreenCanvas;
test.afterEach(() => {
  if (previousCanvas === undefined) delete globalThis.OffscreenCanvas;
  else globalThis.OffscreenCanvas = previousCanvas;
});

function fixture({
  pageHeight = 250,
  viewportHeight = 100,
  width = 20,
  scale = 1,
  mode = "single",
  pageState: stateOverrides = {},
  makeRows,
  scrollResult,
  captureErrorAt = 0,
  captureError = new Error("Capture interrupted"),
  saveError,
  classifyCaptureError = () => "capture_interrupted",
} = {}) {
  const canvases = [];
  const bitmaps = [];
  const pages = [];
  const scrollRequests = [];
  let saveAttempts = 0;
  let captureAttempts = 0;
  let actualScrollY = 0;
  const bitmapHeight = Math.round(viewportHeight * scale);
  const pageState = {
    scrollTarget: "document", pageHeight, viewportHeight,
    viewportWidth: width / scale,
    maxScrollY: Math.max(0, pageHeight - viewportHeight),
    ...stateOverrides,
  };

  globalThis.OffscreenCanvas = class {
    constructor(canvasWidth, canvasHeight) {
      this.width = canvasWidth;
      this.height = canvasHeight;
      this.originalWidth = canvasWidth;
      this.originalHeight = canvasHeight;
      this.rows = Array(canvasHeight).fill(null);
      this.draws = [];
      canvases.push(this);
    }

    getContext(kind) {
      assert.equal(kind, "2d");
      const canvas = this;
      return {
        fillStyle: "",
        fillRect(x, y, width, height) {
          assert.deepEqual([x, y, width, height], [0, 0, canvas.width, canvas.height]);
          canvas.rows.fill(this.fillStyle);
        },
        drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
          assert.deepEqual([sx, sw, dx, dw], [0, canvas.width, 0, canvas.width]);
          assert.equal(sw, source.width);
          assert.equal(sh, dh, "Screenshot strips must never be scaled");
          assert.ok(Number.isSafeInteger(sy) && Number.isSafeInteger(sh) && Number.isSafeInteger(dy));
          assert.ok(sy >= 0 && sy + sh <= source.rows.length);
          assert.ok(dy >= 0 && dy + dh <= canvas.rows.length);
          canvas.draws.push({ sy, sh, dy, dh });
          for (let row = 0; row < sh; row += 1) canvas.rows[dy + row] = source.rows[sy + row];
        },
      };
    }

    async convertToBlob(options) {
      return new Blob([JSON.stringify(this.rows)], { type: options.type });
    }
  };

  return {
    canvases, bitmaps, pages, scrollRequests,
    get captureAttempts() { return captureAttempts; },
    get saveAttempts() { return saveAttempts; },
    run() {
      return captureScreenshotFrames({
        pageState, mode, format: "png", settings: {},
        messages: { viewportChanged: "Viewport changed", scrollStalled: "Scroll stalled" },
        classifyCaptureError,
        async scroll(requestedY) {
          scrollRequests.push(requestedY);
          actualScrollY = scrollResult ? scrollResult(requestedY, scrollRequests.length) : requestedY;
          return { scrollY: actualScrollY };
        },
        async capture() {
          captureAttempts += 1;
          if (captureAttempts === captureErrorAt) throw captureError;
          const source = {
            width,
            height: bitmapHeight,
            rows: makeRows ? makeRows(actualScrollY, bitmapHeight, captureAttempts)
              : Array.from({ length: bitmapHeight }, (_, row) => Math.round(actualScrollY * scale) + row),
            closed: false,
            close() { this.closed = true; },
          };
          bitmaps.push(source);
          return source;
        },
        async onPage(page) {
          saveAttempts += 1;
          if (saveError) throw saveError;
          pages.push({ ...page, rows: JSON.parse(await page.blob.text()) });
        },
      });
    },
  };
}

function assertResourcesReleased(capture) {
  assert.ok(capture.bitmaps.every((source) => source.closed));
  assert.ok(capture.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
}

function rows(count) {
  return Array.from({ length: count }, (_, index) => index);
}

test("document capture removes overlap in the final viewport without missing or duplicate rows", async () => {
  const capture = fixture();
  const result = await capture.run();
  assert.deepEqual(capture.scrollRequests, [0, 100, 150]);
  assert.equal(capture.pages.length, 1);
  assert.deepEqual(capture.pages[0].rows, rows(250));
  assert.deepEqual(result, { partial: false, partialReason: "", capturedHeight: 250, totalHeight: 250, pageCount: 1 });
  assertResourcesReleased(capture);
});

test("document frames cross A4 boundaries and pad only the final page", async () => {
  const capture = fixture({ width: 210, pageHeight: 650, mode: "a4" });
  const result = await capture.run();
  assert.equal(result.pageCount, 3);
  assert.deepEqual(capture.pages.map((page) => page.height), [297, 297, 297]);
  const output = capture.pages.flatMap((page) => page.rows);
  assert.deepEqual(output.slice(0, 650), rows(650));
  assert.deepEqual(output.slice(650), Array(241).fill("#ffffff"));
  assertResourcesReleased(capture);
});

test("element capture retains the first complete viewport then appends only new element rows", async () => {
  const capture = fixture({
    pageHeight: 210,
    pageState: {
      scrollTarget: "element", elementTop: 20,
      elementViewportHeight: 60, elementScrollHeight: 170, maxScrollY: 110,
    },
    makeRows(scrollY) {
      return [
        ...rows(20).map((row) => `header-${row}`),
        ...rows(60).map((row) => `content-${scrollY + row}`),
        ...rows(20).map((row) => `footer-${row}`),
      ];
    },
  });
  const result = await capture.run();
  assert.deepEqual(capture.scrollRequests, [0, 60, 110]);
  assert.deepEqual(capture.pages[0].rows, [
    ...rows(20).map((row) => `header-${row}`),
    ...rows(60).map((row) => `content-${row}`),
    ...rows(20).map((row) => `footer-${row}`),
    ...rows(110).map((row) => `content-${60 + row}`),
  ]);
  assert.equal(result.capturedHeight, 210);
  assertResourcesReleased(capture);
});

test("capture uses actual bitmap scale instead of reported device pixel ratio", async () => {
  const capture = fixture({ width: 40, scale: 2, pageState: { devicePixelRatio: 3 } });
  const result = await capture.run();
  assert.equal(result.totalHeight, 500);
  assert.equal(capture.pages[0].width, 40);
  assert.deepEqual(capture.pages[0].rows, rows(500));
  assertResourcesReleased(capture);
});

test("fractional bitmap scale keeps the final odd CSS row without rounding gaps", async () => {
  const capture = fixture({ width: 30, pageHeight: 251, scale: 1.5 });
  const result = await capture.run();
  assert.equal(result.totalHeight, 377);
  assert.deepEqual(capture.scrollRequests, [0, 100, 151]);
  assert.deepEqual(capture.pages[0].rows, rows(377));
  assertResourcesReleased(capture);
});

test("fractional-scale element capture shares pixel boundaries with the retained first viewport", async () => {
  const capture = fixture({
    width: 30, pageHeight: 211, scale: 1.5,
    pageState: {
      scrollTarget: "element", elementTop: 20,
      elementViewportHeight: 60, elementScrollHeight: 171, maxScrollY: 111,
    },
    makeRows(scrollY) {
      return [
        ...rows(30).map((row) => `header-${row}`),
        ...rows(90).map((row) => `content-${Math.round(scrollY * 1.5) + row}`),
        ...rows(30).map((row) => `footer-${row}`),
      ];
    },
  });
  const result = await capture.run();
  assert.deepEqual(capture.scrollRequests, [0, 60, 111]);
  assert.equal(result.totalHeight, 317);
  assert.deepEqual(capture.pages[0].rows, [
    ...rows(30).map((row) => `header-${row}`),
    ...rows(90).map((row) => `content-${row}`),
    ...rows(30).map((row) => `footer-${row}`),
    ...rows(167).map((row) => `content-${90 + row}`),
  ]);
  assertResourcesReleased(capture);
});

test("oversized single capture requests an explicit choice without saving anything", async () => {
  const capture = fixture({ pageHeight: 33000 });
  await assert.rejects(capture.run(), (error) => {
    assert.ok(error instanceof ScreenshotPaginationRequired);
    assert.deepEqual([error.width, error.height, error.format], [20, 33000, "png"]);
    return true;
  });
  assert.equal(capture.captureAttempts, 1);
  assert.equal(capture.canvases.length, 0);
  assert.equal(capture.saveAttempts, 0);
  assertResourcesReleased(capture);
});

test("capture interruption saves already painted rows as a partial image", async () => {
  const capture = fixture({ captureErrorAt: 3 });
  const result = await capture.run();
  assert.deepEqual(result, { partial: true, partialReason: "capture_interrupted", capturedHeight: 200, totalHeight: 250, pageCount: 1 });
  assert.deepEqual(capture.pages[0].rows, rows(200));
  assert.equal(capture.pages[0].partial, true);
  assert.equal(capture.pages[0].partialReason, "capture_interrupted");
  assert.equal(capture.pages[0].height, 200);
  assertResourcesReleased(capture);
});

test("interruption after a completed page preserves that page and the unfinished tail", async () => {
  const capture = fixture({ width: 210, pageHeight: 650, mode: "a4", captureErrorAt: 5 });
  const result = await capture.run();
  assert.equal(result.partial, true);
  assert.equal(result.capturedHeight, 400);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(capture.pages.map((page) => page.partial), [false, true]);
  assert.deepEqual(capture.pages.flatMap((page) => page.rows).slice(0, 400), rows(400));
  assert.deepEqual(capture.pages[1].rows.slice(103), Array(194).fill("#ffffff"));
  assertResourcesReleased(capture);
});

test("failure before the first frame propagates with zero files and allocations", async () => {
  const failure = new Error("First frame failed");
  const capture = fixture({ captureErrorAt: 1, captureError: failure });
  await assert.rejects(capture.run(), (error) => error === failure);
  assert.equal(capture.pages.length, 0);
  assert.equal(capture.saveAttempts, 0);
  assert.equal(capture.canvases.length, 0);
  assertResourcesReleased(capture);
});

test("saving failure propagates the original error without converting it into a partial retry", async () => {
  const failure = new Error("Destination is full");
  const capture = fixture({ width: 210, pageHeight: 650, mode: "a4", saveError: failure });
  await assert.rejects(capture.run(), (error) => error === failure);
  assert.equal(capture.saveAttempts, 1);
  assert.equal(capture.captureAttempts, 3);
  assert.equal(capture.pages.length, 0);
  assertResourcesReleased(capture);
});

test("unclassified source failures propagate without saving misleading partial output", async () => {
  const failure = new TypeError("Invalid source state");
  const capture = fixture({ captureErrorAt: 2, captureError: failure, classifyCaptureError: () => "" });
  await assert.rejects(capture.run(), (error) => error === failure);
  assert.equal(capture.saveAttempts, 0);
  assertResourcesReleased(capture);
});

test("a stuck scroll target preserves its captured prefix and reports the interruption", async () => {
  const capture = fixture({ scrollResult: () => 0 });
  const result = await capture.run();
  assert.equal(result.partial, true);
  assert.equal(result.partialReason, "scroll_stalled");
  assert.equal(result.capturedHeight, 100);
  assert.deepEqual(capture.pages[0].rows, rows(100));
  assertResourcesReleased(capture);
});
