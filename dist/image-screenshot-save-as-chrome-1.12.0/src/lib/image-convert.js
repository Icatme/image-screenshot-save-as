import {
  IMAGE_ERROR_CODES,
  ImageProcessingError,
  MAX_WEBP_EDGE,
  getCanvasContextOptions,
  getImageEncodeOptions,
  getImageMimeType,
  prepareCanvasForEncoding
} from "./image-encoding.js";

export const MAX_IMAGE_EDGE = 16384;
export const MAX_IMAGE_PIXELS = 80_000_000;
export const MAX_SOURCE_IMAGE_BYTES = 64 * 1024 * 1024;

const ORIGINAL_MIME_TO_FORMAT = Object.freeze({
  "image/gif": { format: "gif", mimeType: "image/gif" },
  "image/png": { format: "png", mimeType: "image/png" },
  "image/apng": { format: "apng", mimeType: "image/apng" },
  "image/jpeg": { format: "jpg", mimeType: "image/jpeg" },
  "image/jpg": { format: "jpg", mimeType: "image/jpeg" },
  "image/webp": { format: "webp", mimeType: "image/webp" },
  "image/avif": { format: "avif", mimeType: "image/avif" },
  "image/svg+xml": { format: "svg", mimeType: "image/svg+xml" },
  "image/bmp": { format: "bmp", mimeType: "image/bmp" },
  "image/x-icon": { format: "ico", mimeType: "image/x-icon" },
  "image/vnd.microsoft.icon": { format: "ico", mimeType: "image/x-icon" }
});

const ORIGINAL_EXT_TO_FORMAT = Object.freeze({
  gif: { format: "gif", mimeType: "image/gif" },
  png: { format: "png", mimeType: "image/png" },
  apng: { format: "apng", mimeType: "image/apng" },
  jpg: { format: "jpg", mimeType: "image/jpeg" },
  jpeg: { format: "jpg", mimeType: "image/jpeg" },
  webp: { format: "webp", mimeType: "image/webp" },
  avif: { format: "avif", mimeType: "image/avif" },
  svg: { format: "svg", mimeType: "image/svg+xml" },
  bmp: { format: "bmp", mimeType: "image/bmp" },
  ico: { format: "ico", mimeType: "image/x-icon" }
});

export async function prepareOriginalImageBlob(sourceBlob, srcUrl = "") {
  validateSourceBlob(sourceBlob);
  if (!sourceBlob?.size) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_EMPTY,
      "The selected image is empty."
    );
  }

  const headerBytes = new Uint8Array(await sourceBlob.slice(0, 512).arrayBuffer());
  const detected =
    detectFormatFromBytes(headerBytes) ||
    detectFormatFromMime(sourceBlob.type) ||
    detectFormatFromUrl(srcUrl, sourceBlob.type);

  if (!detected) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_DECODE_FAILED,
      "This image could not be decoded locally."
    );
  }

  const blob =
    normalizeMimeType(sourceBlob.type) === detected.mimeType
      ? sourceBlob
      : new Blob([sourceBlob], { type: detected.mimeType });

  return {
    blob,
    format: detected.format,
    mimeType: detected.mimeType
  };
}

export async function convertImageBlob(sourceBlob, format, settings) {
  const mimeType = getImageMimeType(format);
  validateSourceBlob(sourceBlob);

  let bitmap;
  try {
    bitmap = await createImageBitmap(sourceBlob);
  } catch (error) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_DECODE_FAILED,
      "This image could not be decoded locally.",
      { cause: error }
    );
  }

  let canvas = null;
  try {
    validateBitmap(bitmap, format);

    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", getCanvasContextOptions(format));
    if (!context) {
      throw new ImageProcessingError(
        IMAGE_ERROR_CODES.CANVAS_UNAVAILABLE,
        "Canvas is unavailable in this browser."
      );
    }

    prepareCanvasForEncoding(context, format, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);

    const blob = await canvas.convertToBlob(getImageEncodeOptions(format, settings));
    if (!blob?.size || blob.type !== mimeType) {
      throw new ImageProcessingError(
        IMAGE_ERROR_CODES.IMAGE_ENCODE_FAILED,
        "This image could not be encoded in the requested format."
      );
    }

    return {
      blob,
      mimeType,
      width: bitmap.width,
      height: bitmap.height
    };
  } catch (error) {
    if (error instanceof ImageProcessingError) {
      throw error;
    }

    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_ENCODE_FAILED,
      "This image could not be encoded locally.",
      { cause: error }
    );
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (bitmap) {
      bitmap.close();
    }
  }
}

function validateSourceBlob(sourceBlob) {
  if (sourceBlob.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.SOURCE_TOO_LARGE,
      `Image source is too large. Max compressed size is ${MAX_SOURCE_IMAGE_BYTES} bytes.`
    );
  }
}

function validateBitmap(bitmap, format) {
  if (!bitmap.width || !bitmap.height) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_EMPTY,
      "The selected image is empty."
    );
  }

  const maxEdge = format === "webp" ? Math.min(MAX_IMAGE_EDGE, MAX_WEBP_EDGE) : MAX_IMAGE_EDGE;
  if (bitmap.width > maxEdge || bitmap.height > maxEdge) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_TOO_LARGE,
      `Image is too large. Max edge is ${maxEdge}px.`
    );
  }

  if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_TOO_LARGE,
      "Image is too large to convert safely."
    );
  }
}

function normalizeMimeType(value) {
  return typeof value === "string"
    ? value.split(";")[0].trim().toLowerCase()
    : "";
}

function detectFormatFromMime(rawMime) {
  const mime = normalizeMimeType(rawMime);
  return Object.hasOwn(ORIGINAL_MIME_TO_FORMAT, mime)
    ? ORIGINAL_MIME_TO_FORMAT[mime]
    : null;
}

function detectFormatFromUrl(srcUrl, rawMime) {
  const mime = normalizeMimeType(rawMime);
  if (mime && mime !== "application/octet-stream" && !mime.startsWith("image/")) {
    return null;
  }
  if (!srcUrl || srcUrl.startsWith("data:") || srcUrl.startsWith("blob:")) {
    return null;
  }
  try {
    const pathname = decodeURIComponent(new URL(srcUrl).pathname);
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    if (!match) {
      return null;
    }
    const ext = match[1].toLowerCase();
    return Object.hasOwn(ORIGINAL_EXT_TO_FORMAT, ext)
      ? ORIGINAL_EXT_TO_FORMAT[ext]
      : null;
  } catch {
    return null;
  }
}

function detectFormatFromBytes(bytes) {
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return ORIGINAL_MIME_TO_FORMAT["image/gif"];
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return ORIGINAL_MIME_TO_FORMAT["image/png"];
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return ORIGINAL_MIME_TO_FORMAT["image/jpeg"];
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return ORIGINAL_MIME_TO_FORMAT["image/webp"];
  }

  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const ftypText = new TextDecoder("ascii").decode(bytes.subarray(8, Math.min(bytes.length, 32)));
    if (ftypText.includes("avif") || ftypText.includes("avis")) {
      return ORIGINAL_MIME_TO_FORMAT["image/avif"];
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return ORIGINAL_MIME_TO_FORMAT["image/bmp"];
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return ORIGINAL_MIME_TO_FORMAT["image/x-icon"];
  }

  const headText = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (
    headText.startsWith("<svg") ||
    ((headText.startsWith("<?xml") || headText.startsWith("<!--")) &&
      headText.includes("<svg"))
  ) {
    return ORIGINAL_MIME_TO_FORMAT["image/svg+xml"];
  }

  return null;
}
