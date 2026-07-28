export const IMAGE_ERROR_CODES = Object.freeze({
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  SOURCE_TOO_LARGE: "SOURCE_TOO_LARGE",
  IMAGE_DECODE_FAILED: "IMAGE_DECODE_FAILED",
  IMAGE_EMPTY: "IMAGE_EMPTY",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  CANVAS_UNAVAILABLE: "CANVAS_UNAVAILABLE",
  IMAGE_ENCODE_FAILED: "IMAGE_ENCODE_FAILED"
});

export const IMAGE_FORMAT_MIME = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp"
});

export class ImageProcessingError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ImageProcessingError";
    this.code = code;
  }
}

export function getImageMimeType(format) {
  const mimeType = Object.hasOwn(IMAGE_FORMAT_MIME, format)
    ? IMAGE_FORMAT_MIME[format]
    : null;
  if (!mimeType) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.UNSUPPORTED_FORMAT,
      `Unsupported output format: ${format}`
    );
  }

  return mimeType;
}

export function getImageEncodeOptions(format, settings) {
  const options = { type: getImageMimeType(format) };

  if (format === "jpg") {
    options.quality = settings.jpgQuality;
  }

  if (format === "webp") {
    options.quality = settings.webpQuality;
  }

  return options;
}

export function getCanvasContextOptions(format) {
  getImageMimeType(format);
  return { alpha: format !== "jpg" };
}

export function prepareCanvasForEncoding(context, format, width, height) {
  getImageMimeType(format);

  if (format !== "jpg") {
    return;
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
}
