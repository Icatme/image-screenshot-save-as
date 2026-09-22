import {
  IMAGE_ERROR_CODES,
  ImageProcessingError,
  getCanvasContextOptions,
  getImageEncodeOptions,
  getImageMimeType,
  prepareCanvasForEncoding,
} from "./image-encoding.js";

export const MAX_SCREENSHOT_EDGE = 32767;
export const MAX_SCREENSHOT_PIXELS = 100_000_000;
// https://developers.google.com/speed/webp/faq#what_is_the_maximum_size_a_webp_image_can_be
const MAX_WEBP_EDGE = 16383;

function isDimension(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function getMaximumEdge(format) {
  getImageMimeType(format);
  return format === "webp" ? MAX_WEBP_EDGE : MAX_SCREENSHOT_EDGE;
}

export function canCaptureSingleImage(width, height, format) {
  const maximumEdge = getMaximumEdge(format);
  return isDimension(width) && isDimension(height)
    && width <= maximumEdge && height <= maximumEdge
    && width * height <= MAX_SCREENSHOT_PIXELS;
}

export function getScreenshotPagePlan({ width, height, format, mode }) {
  const maximumEdge = getMaximumEdge(format);
  if (!isDimension(width) || !isDimension(height)) {
    throw new RangeError("Screenshot dimensions must be positive safe integers.");
  }
  if (!["single", "longest", "a4"].includes(mode)) {
    throw new RangeError(`Unsupported screenshot pagination mode: ${mode}`);
  }

  const pageHeight = mode === "single" ? height
    : mode === "a4" ? Math.round(width * 297 / 210)
      : Math.min(maximumEdge, Math.floor(MAX_SCREENSHOT_PIXELS / width));
  if (!canCaptureSingleImage(width, pageHeight, format)) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_TOO_LARGE,
      `Screenshot page exceeds the ${maximumEdge}px edge or ${MAX_SCREENSHOT_PIXELS} pixel limit.`,
    );
  }

  return { width, height, pageHeight, pageCount: Math.ceil(height / pageHeight), mode };
}

/**
 * Writes consecutive rows without scaling, encoding one page at a time.
 * onPage is awaited before allocating the next page. The caller owns bitmaps.
 */
export function createScreenshotPageWriter({
  plan,
  format,
  settings,
  onPage,
  createCanvas = (width, height) => new OffscreenCanvas(width, height),
}) {
  const expectedPlan = getScreenshotPagePlan({ ...plan, format });
  if (plan.pageHeight !== expectedPlan.pageHeight || plan.pageCount !== expectedPlan.pageCount) {
    throw new RangeError("Screenshot page plan does not match its dimensions and output format.");
  }
  if (typeof onPage !== "function") {
    throw new TypeError("Screenshot page writer requires an onPage callback.");
  }
  // Copy the plan so mutation by a caller cannot change page boundaries mid-capture.
  plan = expectedPlan;
  const encodeOptions = getImageEncodeOptions(format, settings);
  const contextOptions = getCanvasContextOptions(format);
  let canvas = null;
  let context = null;
  let pageStart = 0;
  let paintedHeight = 0;
  let pageCount = 0;
  let closed = false;
  let busy = false;
  let failure = null;

  function release(target) {
    if (target) {
      target.width = 0;
      target.height = 0;
    }
  }

  function releaseCurrent() {
    release(canvas);
    canvas = null;
    context = null;
  }

  function makeCanvas(height) {
    const result = createCanvas(plan.width, height);
    try {
      const resultContext = result.getContext("2d", contextOptions);
      if (!resultContext) {
        throw new ImageProcessingError(
          IMAGE_ERROR_CODES.CANVAS_UNAVAILABLE,
          "Canvas is unavailable in this browser.",
        );
      }
      if (plan.mode === "a4") {
        resultContext.fillStyle = "#ffffff";
        resultContext.fillRect(0, 0, plan.width, height);
      } else {
        prepareCanvasForEncoding(resultContext, format, plan.width, height);
      }
      return { canvas: result, context: resultContext };
    } catch (error) {
      release(result);
      throw error;
    }
  }

  async function flush(partial = false, partialReason = "") {
    if (!canvas || paintedHeight === pageStart) {
      return;
    }
    const contentHeight = paintedHeight - pageStart;
    if (plan.mode !== "a4" && contentHeight < canvas.height) {
      const cropped = makeCanvas(contentHeight);
      try {
        cropped.context.drawImage(
          canvas, 0, 0, plan.width, contentHeight,
          0, 0, plan.width, contentHeight,
        );
      } catch (error) {
        release(cropped.canvas);
        throw error;
      }
      releaseCurrent();
      canvas = cropped.canvas;
      context = cropped.context;
    }

    const height = canvas.height;
    let blob;
    try {
      blob = await canvas.convertToBlob(encodeOptions);
      if (!blob?.size || blob.type !== encodeOptions.type) {
        throw new ImageProcessingError(
          IMAGE_ERROR_CODES.IMAGE_ENCODE_FAILED,
          "Screenshot page could not be encoded in the requested format.",
        );
      }
    } finally {
      // The encoded Blob owns its data; release pixels before saving it.
      releaseCurrent();
    }
    await onPage({
      blob,
      index: pageCount + 1,
      partial,
      partialReason: partial ? partialReason : "",
      capturedHeight: paintedHeight,
      totalHeight: plan.height,
      width: plan.width,
      height,
    });
    pageCount += 1;
    pageStart = paintedHeight;
  }

  async function perform(operation) {
    if (failure) {
      throw failure;
    }
    if (closed) {
      throw new Error("Screenshot page writer is closed.");
    }
    if (busy) {
      throw new Error("Screenshot page writer operations must be awaited in order.");
    }
    busy = true;
    try {
      return await operation();
    } catch (error) {
      failure = error;
      releaseCurrent();
      throw error;
    } finally {
      busy = false;
    }
  }

  return {
    async draw(bitmap, { sourceY, sourceHeight, targetY }) {
      return perform(async () => {
        if (!bitmap || bitmap.width !== plan.width || !isDimension(bitmap.height)
          || !Number.isSafeInteger(sourceY) || sourceY < 0
          || !isDimension(sourceHeight) || sourceHeight > bitmap.height - sourceY
          || targetY !== paintedHeight || sourceHeight > plan.height - targetY) {
          throw new RangeError("Screenshot rows must be consecutive, unscaled, and within the source and page bounds.");
        }

        let remaining = sourceHeight;
        let currentSourceY = sourceY;
        while (remaining > 0) {
          if (!canvas) {
            const outputHeight = plan.mode === "a4" ? plan.pageHeight
              : Math.min(plan.pageHeight, plan.height - pageStart);
            ({ canvas, context } = makeCanvas(outputHeight));
          }
          const localY = paintedHeight - pageStart;
          const sliceHeight = Math.min(remaining, canvas.height - localY);
          context.drawImage(
            bitmap, 0, currentSourceY, plan.width, sliceHeight,
            0, localY, plan.width, sliceHeight,
          );
          paintedHeight += sliceHeight;
          currentSourceY += sliceHeight;
          remaining -= sliceHeight;
          if (paintedHeight - pageStart === canvas.height || paintedHeight === plan.height) {
            await flush();
          }
        }
      });
    },
    async finish({ partial = false, partialReason = "" } = {}) {
      return perform(async () => {
        if (!partial && paintedHeight !== plan.height) {
          throw new RangeError("Screenshot capture ended before all planned rows were painted.");
        }
        await flush(partial, partialReason);
        closed = true;
        return { capturedHeight: paintedHeight, totalHeight: plan.height, pageCount };
      });
    },
    dispose() {
      closed = true;
      releaseCurrent();
    },
    get paintedHeight() {
      return paintedHeight;
    },
    get pageCount() {
      return pageCount;
    },
  };
}
