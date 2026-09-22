import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
  canCaptureSingleImage,
  createScreenshotPageWriter,
  getScreenshotPagePlan,
} from "../src/lib/screenshot-pagination.js";

const settings = { jpgQuality: 0.85, webpQuality: 0.75 };

function bitmap(width, height, offset = 0) {
  return { width, height, rows: Array.from({ length: height }, (_, index) => offset + index) };
}

function setup({ width = 210, height = 700, format = "png", mode = "a4", onPage, encodeError } = {}) {
  const canvases = [];
  const pages = [];
  const plan = getScreenshotPagePlan({ width, height, format, mode });
  const createCanvas = (canvasWidth, canvasHeight) => {
    const entry = {
      originalWidth: canvasWidth,
      originalHeight: canvasHeight,
      width: canvasWidth,
      height: canvasHeight,
      rows: Array(canvasHeight).fill(null),
      fills: [],
      draws: [],
      getContext(kind, options) {
        assert.equal(kind, "2d");
        entry.contextOptions = options;
        return {
          fillStyle: "",
          fillRect(x, y, w, h) {
            assert.deepEqual([x, y, w, h], [0, 0, canvasWidth, canvasHeight]);
            entry.fills.push(this.fillStyle);
            entry.rows.fill(this.fillStyle);
          },
          drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
            // Any scaling or horizontal clipping is a test failure.
            assert.deepEqual([sx, sw, dx, dw], [0, canvasWidth, 0, canvasWidth]);
            assert.equal(sh, dh);
            assert.ok(Number.isSafeInteger(sy) && Number.isSafeInteger(dy) && Number.isSafeInteger(sh));
            assert.ok(sy + sh <= source.rows.length);
            assert.ok(dy + dh <= entry.rows.length);
            entry.draws.push({ sy, sh, dy, dh });
            for (let row = 0; row < sh; row += 1) {
              entry.rows[dy + row] = source.rows[sy + row];
            }
          },
        };
      },
      async convertToBlob(options) {
        entry.encodeOptions = options;
        if (encodeError) {
          throw encodeError;
        }
        return new Blob([JSON.stringify(entry.rows)], { type: options.type });
      },
    };
    canvases.push(entry);
    return entry;
  };
  const writer = createScreenshotPageWriter({
    plan, format, settings, createCanvas,
    async onPage(page) {
      const output = { ...page, rows: JSON.parse(await page.blob.text()) };
      pages.push(output);
      if (onPage) {
        await onPage(output);
      }
    },
  });
  return { writer, pages, canvases, plan };
}

function assertReleased(canvases) {
  for (const canvas of canvases) {
    assert.deepEqual([canvas.width, canvas.height], [0, 0]);
  }
}

test("plans arbitrarily tall screenshots without a whole-document canvas", () => {
  assert.deepEqual(getScreenshotPagePlan({ width: 1000, height: 1_000_000, format: "png", mode: "longest" }), {
    width: 1000, height: 1_000_000, pageHeight: 32767, pageCount: 31, mode: "longest",
  });
  assert.equal(MAX_SCREENSHOT_EDGE, 32767);
  assert.equal(MAX_SCREENSHOT_PIXELS, 100_000_000);
});

test("single and longest respect both area and format edge limits", () => {
  assert.equal(canCaptureSingleImage(4000, 25000, "png"), true);
  assert.equal(canCaptureSingleImage(4000, 25001, "png"), false);
  assert.equal(canCaptureSingleImage(1, 32767, "jpg"), true);
  assert.equal(canCaptureSingleImage(1, 32768, "jpg"), false);
  assert.equal(canCaptureSingleImage(1, 16383, "webp"), true);
  assert.equal(canCaptureSingleImage(1, 16384, "webp"), false);
  assert.equal(canCaptureSingleImage(16384, 1, "webp"), false);
  assert.equal(getScreenshotPagePlan({ width: 4000, height: 90000, format: "png", mode: "longest" }).pageHeight, 25000);
  assert.equal(getScreenshotPagePlan({ width: 1000, height: 90000, format: "webp", mode: "longest" }).pageHeight, 16383);
  for (const mode of ["single", "longest", "a4"]) {
    assert.throws(() => getScreenshotPagePlan({ width: 32768, height: 1, format: "png", mode }), { code: "IMAGE_TOO_LARGE" });
  }
  assert.throws(() => getScreenshotPagePlan({ width: 1000, height: 40000, format: "png", mode: "single" }), { code: "IMAGE_TOO_LARGE" });
});

test("A4 preserves source width and rejects an oversized page instead of scaling", () => {
  assert.deepEqual(getScreenshotPagePlan({ width: 1000, height: 4000, format: "png", mode: "a4" }), {
    width: 1000, height: 4000, pageHeight: 1414, pageCount: 3, mode: "a4",
  });
  assert.throws(() => getScreenshotPagePlan({ width: 10000, height: 20000, format: "png", mode: "a4" }), { code: "IMAGE_TOO_LARGE" });
});

test("invalid dimensions, mode and format fail before allocation", () => {
  for (const dimension of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", undefined]) {
    assert.equal(canCaptureSingleImage(dimension, 100, "png"), false);
    assert.equal(canCaptureSingleImage(100, dimension, "png"), false);
    assert.throws(() => getScreenshotPagePlan({ width: dimension, height: 100, format: "png", mode: "longest" }), RangeError);
    assert.throws(() => getScreenshotPagePlan({ width: 100, height: dimension, format: "png", mode: "longest" }), RangeError);
  }
  assert.throws(() => getScreenshotPagePlan({ width: 10, height: 10, format: "gif", mode: "longest" }), { code: "UNSUPPORTED_FORMAT" });
  assert.throws(() => getScreenshotPagePlan({ width: 10, height: 10, format: "png", mode: "shrink" }), RangeError);
});

test("consecutive frames cross page boundaries without losing or repeating rows", async () => {
  const { writer, pages, canvases } = setup({ width: 10, height: 70000, mode: "longest" });
  assert.equal(canvases.length, 0);
  await writer.draw(bitmap(10, 32000), { sourceY: 0, sourceHeight: 32000, targetY: 0 });
  assert.equal(pages.length, 0);
  await writer.draw(bitmap(10, 40010, 31990), { sourceY: 10, sourceHeight: 35000, targetY: 32000 });
  assert.equal(pages.length, 2);
  await writer.draw(bitmap(10, 3010, 66990), { sourceY: 10, sourceHeight: 3000, targetY: 67000 });
  await writer.finish();
  assert.deepEqual(pages.map((page) => [page.index, page.width, page.height]), [[1, 10, 32767], [2, 10, 32767], [3, 10, 4466]]);
  assert.deepEqual(pages.flatMap((page) => page.rows), bitmap(10, 70000).rows);
  assert.deepEqual(canvases.map((canvas) => canvas.originalHeight), [32767, 32767, 4466]);
  assert.ok(canvases.every((canvas) => canvas.fills.length === 0));
  assert.deepEqual(pages.map((page) => page.capturedHeight), [32767, 65534, 70000]);
  assert.ok(pages.every((page) => page.totalHeight === 70000 && !page.partial));
  assert.equal(writer.paintedHeight, 70000);
  assert.equal(writer.pageCount, 3);
  assertReleased(canvases);
});

test("A4 pages retain full paper height with a white padded final page", async () => {
  const { writer, pages, canvases } = setup();
  await writer.draw(bitmap(210, 700), { sourceY: 0, sourceHeight: 700, targetY: 0 });
  await writer.finish();
  assert.deepEqual(pages.map((page) => page.height), [297, 297, 297]);
  assert.deepEqual(pages.flatMap((page) => page.rows).slice(0, 700), bitmap(210, 700).rows);
  assert.deepEqual(pages[2].rows.slice(106), Array(191).fill("#ffffff"));
  assert.ok(canvases.every((canvas) => canvas.fills[0] === "#ffffff"));
  assertReleased(canvases);
});

test("partial longest page is cropped and only the unfinished page is marked partial", async () => {
  const { writer, pages, canvases } = setup({ width: 10, height: 70000, mode: "longest" });
  await writer.draw(bitmap(10, 33000), { sourceY: 0, sourceHeight: 33000, targetY: 0 });
  const result = await writer.finish({ partial: true, partialReason: "capture_stopped" });
  assert.deepEqual(result, { capturedHeight: 33000, totalHeight: 70000, pageCount: 2 });
  assert.deepEqual(pages.map((page) => [page.height, page.partial, page.partialReason]), [
    [32767, false, ""], [233, true, "capture_stopped"],
  ]);
  assert.deepEqual(pages.flatMap((page) => page.rows), bitmap(10, 33000).rows);
  assertReleased(canvases);
});

test("partial A4 page is white padded and interruption at a page boundary adds no empty page", async () => {
  const partial = setup();
  await partial.writer.draw(bitmap(210, 310), { sourceY: 0, sourceHeight: 310, targetY: 0 });
  await partial.writer.finish({ partial: true, partialReason: "interrupted" });
  assert.equal(partial.pages[1].height, 297);
  assert.equal(partial.pages[1].partial, true);
  assert.equal(partial.pages[1].partialReason, "interrupted");
  assert.deepEqual(partial.pages[1].rows.slice(13), Array(284).fill("#ffffff"));
  assertReleased(partial.canvases);

  const boundary = setup();
  await boundary.writer.draw(bitmap(210, 297), { sourceY: 0, sourceHeight: 297, targetY: 0 });
  await boundary.writer.finish({ partial: true, partialReason: "interrupted" });
  assert.equal(boundary.pages.length, 1);
  assert.equal(boundary.pages[0].partial, false);
  assertReleased(boundary.canvases);
});

test("no content means no canvas and no saved page", async () => {
  const { writer, pages, canvases } = setup();
  const result = await writer.finish({ partial: true, partialReason: "capture_stopped" });
  assert.equal(result.capturedHeight, 0);
  assert.equal(writer.pageCount, 0);
  assert.equal(pages.length, 0);
  assert.equal(canvases.length, 0);
});

test("single mode preserves the original full size or crops an interrupted capture", async () => {
  const complete = setup({ width: 10, height: 20, mode: "single", format: "jpg" });
  await complete.writer.draw(bitmap(10, 20), { sourceY: 0, sourceHeight: 20, targetY: 0 });
  await complete.writer.finish();
  assert.equal(complete.pages[0].height, 20);
  assert.deepEqual(complete.canvases[0].contextOptions, { alpha: false });
  assert.deepEqual(complete.canvases[0].encodeOptions, { type: "image/jpeg", quality: 0.85 });
  assert.deepEqual(complete.canvases[0].fills, ["#ffffff"]);
  assertReleased(complete.canvases);

  const partial = setup({ width: 10, height: 20, mode: "single" });
  await partial.writer.draw(bitmap(10, 7), { sourceY: 0, sourceHeight: 7, targetY: 0 });
  await partial.writer.finish({ partial: true, partialReason: "stopped" });
  assert.equal(partial.pages[0].height, 7);
  assert.deepEqual(partial.pages[0].rows, bitmap(10, 7).rows);
  assertReleased(partial.canvases);
});

test("WebP pagination uses its smaller edge limit and preserves configured quality", async () => {
  const { writer, pages, canvases } = setup({ width: 10, height: 17000, mode: "longest", format: "webp" });
  await writer.draw(bitmap(10, 17000), { sourceY: 0, sourceHeight: 17000, targetY: 0 });
  await writer.finish();
  assert.deepEqual(pages.map((page) => page.height), [16383, 617]);
  assert.deepEqual(pages.flatMap((page) => page.rows), bitmap(10, 17000).rows);
  for (const canvas of canvases) {
    assert.deepEqual(canvas.contextOptions, { alpha: true });
    assert.deepEqual(canvas.encodeOptions, { type: "image/webp", quality: 0.75 });
  }
  assertReleased(canvases);
});

test("next page waits for the previous save, with the encoded canvas already released", async () => {
  let resolveSave;
  let notifySave;
  const saving = new Promise((resolve) => { notifySave = resolve; });
  const saved = new Promise((resolve) => { resolveSave = resolve; });
  const capture = setup({
    width: 210, height: 300,
    async onPage(page) {
      if (page.index === 1) {
        notifySave();
        await saved;
      }
    },
  });
  const draw = capture.writer.draw(bitmap(210, 300), { sourceY: 0, sourceHeight: 300, targetY: 0 });
  await saving;
  assert.equal(capture.canvases.length, 1);
  assert.equal(capture.writer.pageCount, 0);
  assertReleased(capture.canvases);
  resolveSave();
  await draw;
  await capture.writer.finish();
  assert.equal(capture.pages.length, 2);
  assertReleased(capture.canvases);
});

test("saving errors propagate unchanged and are never retried", async () => {
  const failure = new Error("disk full");
  const { writer, pages, canvases } = setup({ async onPage() { throw failure; } });
  await assert.rejects(writer.draw(bitmap(210, 700), { sourceY: 0, sourceHeight: 700, targetY: 0 }), (error) => error === failure);
  await assert.rejects(writer.finish({ partial: true, partialReason: "failure" }), (error) => error === failure);
  assert.equal(pages.length, 1);
  assert.equal(writer.pageCount, 0);
  assert.equal(canvases.length, 1);
  assertReleased(canvases);
});

test("encoding errors propagate and release the active canvas", async () => {
  const failure = new Error("encoder failed");
  const { writer, pages, canvases } = setup({ encodeError: failure });
  await assert.rejects(writer.draw(bitmap(210, 700), { sourceY: 0, sourceHeight: 700, targetY: 0 }), (error) => error === failure);
  assert.equal(pages.length, 0);
  assertReleased(canvases);
});

test("unavailable canvas context releases allocated pixels and fails before saving", async () => {
  const canvas = { width: 210, height: 297, getContext: () => null };
  const writer = createScreenshotPageWriter({
    plan: getScreenshotPagePlan({ width: 210, height: 500, format: "png", mode: "a4" }),
    format: "png", settings,
    createCanvas: () => canvas,
    onPage: () => assert.fail("No page can be encoded without a context"),
  });
  await assert.rejects(writer.draw(bitmap(210, 10), { sourceY: 0, sourceHeight: 10, targetY: 0 }), { code: "CANVAS_UNAVAILABLE" });
  assertReleased([canvas]);
});

test("forged page plans cannot bypass limits or page boundary validation", () => {
  const plan = getScreenshotPagePlan({ width: 210, height: 500, format: "png", mode: "a4" });
  for (const change of [{ pageHeight: 999999 }, { pageCount: 1 }]) {
    assert.throws(() => createScreenshotPageWriter({
      plan: { ...plan, ...change }, format: "png", settings,
      createCanvas: () => assert.fail("Invalid plans must fail before allocating"),
      onPage() {},
    }), RangeError);
  }
});

test("gaps, overlap, scaling and invalid crop bounds fail without silently clipping", async () => {
  for (const [source, slice] of [
    [bitmap(210, 20), { sourceY: 0, sourceHeight: 10, targetY: 1 }],
    [bitmap(211, 20), { sourceY: 0, sourceHeight: 10, targetY: 0 }],
    [bitmap(210, 20), { sourceY: -1, sourceHeight: 10, targetY: 0 }],
    [bitmap(210, 20), { sourceY: 11, sourceHeight: 10, targetY: 0 }],
    [bitmap(210, 20), { sourceY: 0, sourceHeight: 0, targetY: 0 }],
    [bitmap(210, 20), { sourceY: 0, sourceHeight: 1.5, targetY: 0 }],
    [bitmap(210, 701), { sourceY: 0, sourceHeight: 701, targetY: 0 }],
  ]) {
    const { writer, canvases } = setup();
    await assert.rejects(writer.draw(source, slice), RangeError);
    assert.equal(canvases.length, 0);
  }
  const { writer, canvases } = setup();
  await writer.draw(bitmap(210, 10), { sourceY: 0, sourceHeight: 10, targetY: 0 });
  await assert.rejects(writer.draw(bitmap(210, 10), { sourceY: 0, sourceHeight: 10, targetY: 9 }), RangeError);
  assertReleased(canvases);
});

test("incomplete capture requires an explicit partial finish", async () => {
  const { writer, pages, canvases } = setup();
  await writer.draw(bitmap(210, 10), { sourceY: 0, sourceHeight: 10, targetY: 0 });
  await assert.rejects(writer.finish(), /before all planned rows/);
  assert.equal(pages.length, 0);
  assertReleased(canvases);
});

test("dispose releases unfinished pages and prevents further writes", async () => {
  const { writer, pages, canvases } = setup();
  await writer.draw(bitmap(210, 10), { sourceY: 0, sourceHeight: 10, targetY: 0 });
  writer.dispose();
  writer.dispose();
  assertReleased(canvases);
  assert.equal(pages.length, 0);
  await assert.rejects(writer.finish({ partial: true }), /closed/);
});
