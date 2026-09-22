import assert from "node:assert/strict";
import test from "node:test";
import { preparePageForScreenshot, scrollPageForScreenshot, isPagePreparedForScreenshot, restorePageAfterScreenshot } from "../src/lib/screenshot-page.js";

function pageFixture(t) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const attributes = new Map();
  const style = () => ({
    scrollBehavior: "smooth", getPropertyValue: () => "", getPropertyPriority: () => "",
    setProperty() {}, removeProperty() {},
  });
  const root = {
    style: style(), scrollHeight: 600_000,
    getBoundingClientRect: () => ({ height: 600_000 }),
    getAttribute: name => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const window = {
    innerWidth: 1280, innerHeight: 800, scrollX: 5, scrollY: 120, devicePixelRatio: 1,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
    setTimeout(callback, delay) { timers.set(++nextId, { callback, due: now + delay }); return nextId; },
  };
  const globals = { document: { documentElement: root, scrollingElement: root, body: { style: style() } }, window, requestAnimationFrame: callback => callback() };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.method(Date, "now", () => now);
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    window, root, timers,
    advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.due;
        timers.delete(id);
        timer.callback();
      }
      now = end;
    },
    async scroll(state, y) {
      const result = scrollPageForScreenshot(state, y);
      this.advance(80);
      return result;
    },
  };
}

test("capture progress renews recovery past the original five-minute deadline", async t => {
  const page = pageFixture(t);
  const state = preparePageForScreenshot(300_000);
  page.advance(290_000);
  await page.scroll(state, 800);
  page.advance(20_000);
  assert.equal(isPagePreparedForScreenshot(state), true);
  assert.equal(page.window.scrollY, 800);
  page.advance(280_000);
  assert.equal(isPagePreparedForScreenshot(state), false);
  assert.equal(page.window.scrollY, 120);
  assert.equal(page.root.style.scrollBehavior, "smooth");
  assert.equal(page.timers.size, 0);
});

test("repeated progress survives multiple deadlines then explicit restoration ends recovery", async t => {
  const page = pageFixture(t);
  const state = preparePageForScreenshot(300_000);
  for (let i = 1; i <= 6; i += 1) {
    page.advance(200_000);
    await page.scroll(state, i * 800);
    assert.equal(isPagePreparedForScreenshot(state), true);
  }
  restorePageAfterScreenshot(state);
  page.advance(300_000);
  assert.equal(page.window.scrollY, 120);
  assert.equal(page.timers.size, 0);
});

test("a previous capture's recovery cannot remove the next capture", t => {
  const page = pageFixture(t);
  preparePageForScreenshot(300_000);
  page.advance(200_000);
  const next = preparePageForScreenshot(300_000);
  page.advance(100_000);
  assert.equal(isPagePreparedForScreenshot(next), true);
  page.advance(200_000);
  assert.equal(isPagePreparedForScreenshot(next), false);
});
