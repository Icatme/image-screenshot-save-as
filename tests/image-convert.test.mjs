import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_IMAGE_EDGE,
  MAX_SOURCE_IMAGE_BYTES,
  convertImageBlob,
} from "../src/lib/image-convert.js";

function installCanvasMocks() {
  const observations = {
    bitmapClosed: false,
    contextOptions: null,
    operations: [],
    blobOptions: null,
  };

  globalThis.createImageBitmap = async () => ({
    width: 2,
    height: 1,
    close() {
      observations.bitmapClosed = true;
    },
  });

  globalThis.OffscreenCanvas = class {
    getContext(kind, options) {
      assert.equal(kind, "2d");
      observations.contextOptions = options;
      return {
        set fillStyle(value) {
          observations.operations.push(["fillStyle", value]);
        },
        fillRect(...args) {
          observations.operations.push(["fillRect", ...args]);
        },
        drawImage(...args) {
          observations.operations.push(["drawImage", ...args.slice(1)]);
        },
      };
    }

    async convertToBlob(options) {
      observations.blobOptions = options;
      return new Blob(["converted"], { type: options.type });
    }
  };

  return observations;
}

test.afterEach(() => {
  delete globalThis.createImageBitmap;
  delete globalThis.OffscreenCanvas;
});

test("WebP conversion keeps an alpha-capable canvas", async () => {
  const observations = installCanvasMocks();
  const result = await convertImageBlob(new Blob(["source"]), "webp", {
    jpgQuality: 0.8,
    webpQuality: 0.7,
  });

  assert.deepEqual(observations.contextOptions, { alpha: true });
  assert.deepEqual(observations.blobOptions, {
    type: "image/webp",
    quality: 0.7,
  });
  assert.equal(result.mimeType, "image/webp");
  assert.equal(observations.bitmapClosed, true);
});

test("JPEG conversion flattens transparency onto white before drawing", async () => {
  const observations = installCanvasMocks();
  await convertImageBlob(new Blob(["source"]), "jpg", {
    jpgQuality: 0.85,
    webpQuality: 0.7,
  });

  assert.deepEqual(observations.contextOptions, { alpha: false });
  assert.deepEqual(observations.operations.slice(0, 3), [
    ["fillStyle", "#ffffff"],
    ["fillRect", 0, 0, 2, 1],
    ["drawImage", 0, 0, 2, 1],
  ]);
  assert.deepEqual(observations.blobOptions, {
    type: "image/jpeg",
    quality: 0.85,
  });
});

test("unsupported formats fail before decoding", async () => {
  let decodeCalled = false;
  globalThis.createImageBitmap = async () => {
    decodeCalled = true;
  };

  await assert.rejects(
    convertImageBlob(new Blob(), "gif", {}),
    /Unsupported output format: gif/,
  );
  assert.equal(decodeCalled, false);
});

test("oversized compressed sources fail before decoding", async () => {
  let decodeCalled = false;
  globalThis.createImageBitmap = async () => {
    decodeCalled = true;
  };

  const oversizedBlob = { size: 64 * 1024 * 1024 + 1 };
  assert.equal(MAX_SOURCE_IMAGE_BYTES, 64 * 1024 * 1024);
  await assert.rejects(
    convertImageBlob(oversizedBlob, "png", {}),
    (error) => error?.code === "SOURCE_TOO_LARGE",
  );
	assert.equal(decodeCalled, false);
});

test("oversized decoded dimensions fail with a stable error code", async () => {
  let bitmapClosed = false;
  globalThis.createImageBitmap = async () => ({
    width: MAX_IMAGE_EDGE + 1,
    height: 1,
    close() {
      bitmapClosed = true;
    },
  });

  await assert.rejects(
    convertImageBlob(new Blob(["source"]), "png", {}),
    (error) =>
      error?.code === "IMAGE_TOO_LARGE" &&
      error.message.includes(String(MAX_IMAGE_EDGE)),
  );
  assert.equal(bitmapClosed, true);
});
