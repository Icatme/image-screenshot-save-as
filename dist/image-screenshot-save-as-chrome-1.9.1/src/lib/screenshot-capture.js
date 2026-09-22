import {
  canCaptureSingleImage,
  createScreenshotPageWriter,
  getScreenshotPagePlan,
} from "./screenshot-pagination.js";

export class ScreenshotPaginationRequired extends Error {
  constructor(width, height, format) {
    super("Choose how to split this screenshot into pages.");
    this.name = "ScreenshotPaginationRequired";
    this.width = width;
    this.height = height;
    this.format = format;
  }
}

// Source capture and output are separate: only capture interruptions can produce
// a partial result. Encoding or saving failures must propagate without retrying.
export async function captureScreenshotFrames({
  pageState,
  format,
  settings,
  mode = "single",
  scroll,
  capture,
  onPage,
  classifyCaptureError,
  messages,
}) {
  let writer;
  let plan;
  let capturedCssHeight = 0;
  let scaleY = 1;
  let bitmapWidth;
  let bitmapHeight;
  let writing = false;
  let partialReason = "";
  const element = pageState.scrollTarget === "element";
  const contentHeight = element ? pageState.elementScrollHeight : pageState.pageHeight;

  try {
    while (capturedCssHeight < contentHeight) {
      const scrollState = await scroll(Math.min(capturedCssHeight, pageState.maxScrollY));
      const bitmap = await capture();
      try {
        if (!writer) {
          bitmapWidth = bitmap.width;
          bitmapHeight = bitmap.height;
          scaleY = bitmap.height / pageState.viewportHeight;
          const height = Math.round(pageState.pageHeight * scaleY);
          if (mode === "single" && !canCaptureSingleImage(bitmap.width, height, format)) {
            throw new ScreenshotPaginationRequired(bitmap.width, height, format);
          }
          plan = getScreenshotPagePlan({ width: bitmap.width, height, format, mode });
          writer = createScreenshotPageWriter({ plan, format, settings, onPage });
        } else if (bitmap.width !== bitmapWidth || bitmap.height !== bitmapHeight) {
          throw new Error(messages.viewportChanged);
        }

        const actualScrollY = Number(scrollState?.scrollY) || 0;
        if (actualScrollY > capturedCssHeight + 1) {
          throw stalled();
        }

        let sourceY;
        let nextCssHeight;
        let targetEnd;
        if (element && capturedCssHeight === 0) {
          sourceY = 0;
          nextCssHeight = Math.min(pageState.elementViewportHeight, contentHeight);
          targetEnd = Math.min(bitmap.height, plan.height);
        } else {
          const cropTopCss = Math.max(0, capturedCssHeight - actualScrollY);
          const viewportHeight = element ? pageState.elementViewportHeight : pageState.viewportHeight;
          const drawableCssHeight = Math.min(viewportHeight - cropTopCss, contentHeight - capturedCssHeight);
          if (drawableCssHeight <= 0) throw stalled();
          // Use a shared physical-pixel origin. Rounding the CSS crop and the
          // output cursor separately loses a row at fractional scale factors.
          sourceY = element
            ? Math.round(pageState.elementTop * scaleY) + writer.paintedHeight
              - Math.round((pageState.viewportHeight - pageState.elementViewportHeight + actualScrollY) * scaleY)
            : writer.paintedHeight - Math.round(actualScrollY * scaleY);
          sourceY = Math.max(0, sourceY);
          nextCssHeight = capturedCssHeight + drawableCssHeight;
          const outputCssHeight = element
            ? pageState.viewportHeight + nextCssHeight - pageState.elementViewportHeight
            : nextCssHeight;
          targetEnd = Math.min(plan.height, Math.round(outputCssHeight * scaleY));
        }

        const sourceHeight = Math.min(bitmap.height - sourceY, targetEnd - writer.paintedHeight);
        if (sourceHeight <= 0) throw stalled();
        writing = true;
        await writer.draw(bitmap, { sourceY, sourceHeight, targetY: writer.paintedHeight });
        writing = false;
        capturedCssHeight = nextCssHeight;
        if (writer.paintedHeight >= plan.height) break;
      } finally {
        bitmap.close();
      }
    }
  } catch (error) {
    partialReason = error.partialReason || classifyCaptureError(error);
    if (writing || !writer?.paintedHeight || !partialReason || error instanceof ScreenshotPaginationRequired) {
      writer?.dispose();
      throw error;
    }
  }

  try {
    await writer.finish({ partial: Boolean(partialReason), partialReason });
    return {
      partial: Boolean(partialReason),
      partialReason,
      capturedHeight: writer.paintedHeight,
      totalHeight: plan.height,
      pageCount: writer.pageCount,
    };
  } finally {
    writer?.dispose();
  }

  function stalled() {
    const error = new Error(messages.scrollStalled);
    error.partialReason = "scroll_stalled";
    return error;
  }
}
