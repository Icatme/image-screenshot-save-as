import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDownloadPath,
  buildScreenshotDownloadPath,
  buildScreenshotPageFilename,
} from "../src/lib/file-name.js";

test("numbered screenshots preserve ordering, format, and partial status", () => {
  assert.equal(buildScreenshotPageFilename("Report-full-page-screenshot.png", 1), "Report-full-page-screenshot-001.png");
  assert.equal(buildScreenshotPageFilename("Report.webp", 25, true), "Report-025-partial.webp");
  assert.equal(buildScreenshotPageFilename("Report.jpg", 1000), "Report-1000.jpg");
  assert.throws(() => buildScreenshotPageFilename("Report.png", 0), RangeError);
  assert.throws(() => buildScreenshotPageFilename("Report.zip", 1), TypeError);
  assert.ok(buildScreenshotPageFilename(`${"x".repeat(300)}.png`, 12).endsWith("-012.png"));
});

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

test("buildScreenshotDownloadPath distinguishes screenshot modes", () => {
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
  assert.equal(
    buildScreenshotDownloadPath({
      pageTitle: "Dashboard",
      pageUrl: "https://example.test/dashboard",
      mode: "region",
      format: "webp",
    }),
    "Dashboard-selected-area-screenshot.webp",
  );
});

test("buildScreenshotDownloadPath marks partial screenshot exports", () => {
  assert.equal(
    buildScreenshotDownloadPath({
      pageTitle: "Quarterly report",
      pageUrl: "https://example.test/report",
      mode: "full-page",
      format: "png",
      partial: true,
    }),
    "Quarterly-report-full-page-screenshot-partial.png",
  );
  assert.equal(
    buildScreenshotDownloadPath({
      pageTitle: "Quarterly report",
      pageUrl: "https://example.test/report",
      mode: "full-page",
      format: "png",
      partial: false,
    }),
    "Quarterly-report-full-page-screenshot.png",
  );
});
