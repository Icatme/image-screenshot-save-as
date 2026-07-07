const FORMAT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp"
};

const MAX_EDGE = 16384;
const MAX_PIXELS = 80_000_000;

export async function convertImageBlob(sourceBlob, format, settings) {
  const mimeType = FORMAT_MIME[format];
  if (!mimeType) {
    throw new Error(`Unsupported output format: ${format}`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(sourceBlob);
  } catch {
    throw new Error("This image could not be decoded locally.");
  }

  try {
    validateBitmap(bitmap);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { alpha: format === "png" });
    if (!context) {
      throw new Error("Canvas is unavailable in this browser.");
    }

    if (format === "jpg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, bitmap.width, bitmap.height);
    }

    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);

    const options = { type: mimeType };
    if (format === "jpg") {
      options.quality = settings.jpgQuality;
    }

    if (format === "webp") {
      options.quality = settings.webpQuality;
    }

    const blob = await canvas.convertToBlob(options);
    return {
      blob,
      mimeType,
      width: bitmap.width,
      height: bitmap.height
    };
  } finally {
    if (bitmap) {
      bitmap.close();
    }
  }
}

function validateBitmap(bitmap) {
  if (!bitmap.width || !bitmap.height) {
    throw new Error("The selected image is empty.");
  }

  if (bitmap.width > MAX_EDGE || bitmap.height > MAX_EDGE) {
    throw new Error(`Image is too large. Max edge is ${MAX_EDGE}px.`);
  }

  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    throw new Error("Image is too large to convert safely.");
  }
}
