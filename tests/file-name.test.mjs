import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDownloadPath,
  buildScreenshotDownloadPath,
} from "../src/lib/file-name.js";

test("buildDownloadPath decodes the image name and replaces unsafe characters", () => {
  assert.equal(
    buildDownloadPath({
      srcUrl: "https://example.test/images/My%20Photo%3Ffinal.png?size=large",
      pageTitle: "ignored",
      format: "webp",
    }),
    "My-Photo-final.webp",
  );
});

test("buildDownloadPath avoids Windows reserved names", () => {
  assert.equal(
    buildDownloadPath({
      srcUrl: "https://example.test/CON.jpg",
      pageTitle: "ignored",
      format: "jpg",
    }),
    "CON-file.jpg",
  );
});

test("buildDownloadPath falls back to a safe default and format", () => {
  assert.equal(
    buildDownloadPath({
      srcUrl: "data:image/png;base64,AA==",
      pageTitle: "",
      format: "unsupported",
    }),
    "image.png",
  );
});

test("buildScreenshotDownloadPath distinguishes full and visible captures", () => {
  assert.equal(
    buildScreenshotDownloadPath({
      pageTitle: "Quarterly report",
      pageUrl: "https://example.test/report",
      mode: "full-page",
      format: "png",
    }),
    "Quarterly-report-full-page-screenshot.png",
  );
  assert.equal(
    buildScreenshotDownloadPath({
      pageTitle: "",
      pageUrl: "https://example.test/articles/release-notes.html",
      mode: "visible",
      format: "jpg",
    }),
    "release-notes-visible-screenshot.jpg",
  );
});
