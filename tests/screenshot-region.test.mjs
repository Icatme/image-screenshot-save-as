import assert from "node:assert/strict";
import test from "node:test";

import { getScreenshotRegionPixels } from "../src/lib/screenshot-region.js";

test("getScreenshotRegionPixels scales CSS coordinates to captured pixels", () => {
	assert.deepEqual(
		getScreenshotRegionPixels(
			{
				x: 10,
				y: 5,
				width: 50,
				height: 25,
				viewportWidth: 100,
				viewportHeight: 50,
			},
			200,
			100,
		),
		{ x: 20, y: 10, width: 100, height: 50 },
	);
});

test("getScreenshotRegionPixels scales visual viewport coordinates after pinch zoom", () => {
	assert.deepEqual(
		getScreenshotRegionPixels(
			{
				x: 20,
				y: 30,
				width: 100,
				height: 70,
				viewportWidth: 400,
				viewportHeight: 300,
			},
			800,
			600,
		),
		{ x: 40, y: 60, width: 200, height: 140 },
	);
});

test("getScreenshotRegionPixels clamps a selection to the captured viewport", () => {
	assert.deepEqual(
		getScreenshotRegionPixels(
			{
				x: -10,
				y: 40,
				width: 30,
				height: 30,
				viewportWidth: 100,
				viewportHeight: 50,
			},
			250,
			125,
		),
		{ x: 0, y: 100, width: 50, height: 25 },
	);
});

test("getScreenshotRegionPixels rejects empty or invalid selections", () => {
	assert.equal(
		getScreenshotRegionPixels(
			{
				x: 10,
				y: 10,
				width: 0,
				height: 20,
				viewportWidth: 100,
				viewportHeight: 50,
			},
			200,
			100,
		),
		null,
	);
	assert.equal(
		getScreenshotRegionPixels(
			{
				x: 100,
				y: 10,
				width: 20,
				height: 20,
				viewportWidth: 100,
				viewportHeight: 50,
			},
			200,
			100,
		),
		null,
	);
});
