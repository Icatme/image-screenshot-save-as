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
