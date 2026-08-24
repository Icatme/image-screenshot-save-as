import {
  IMAGE_ERROR_CODES,
  ImageProcessingError,
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

  try {
    validateBitmap(bitmap);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
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

function validateBitmap(bitmap) {
  if (!bitmap.width || !bitmap.height) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_EMPTY,
      "The selected image is empty."
    );
  }

  if (bitmap.width > MAX_IMAGE_EDGE || bitmap.height > MAX_IMAGE_EDGE) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_TOO_LARGE,
      `Image is too large. Max edge is ${MAX_IMAGE_EDGE}px.`
    );
  }

  if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    throw new ImageProcessingError(
      IMAGE_ERROR_CODES.IMAGE_TOO_LARGE,
      "Image is too large to convert safely."
    );
  }
}
