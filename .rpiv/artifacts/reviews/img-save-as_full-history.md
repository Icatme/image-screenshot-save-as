---
repository: img-save-as
branch: main
commit: 589f958
date: 2026-07-12
reviewer: code-review
scope: HEAD~4..HEAD (5 commits, full history)
strategy: explicit-range
verification: V:5 W:1 F:0
status: ready
blockers: 0
---

# Code Review: img-save-as (Full History)

## Summary

Chrome extension for saving images in multiple formats (PNG, JPG, WebP) with screenshot capture, i18n support (5 locales), and local save history. Review covers all 5 commits since repository inception.

**Lenses applied:** Quality, Security  
**Files reviewed:** 9 source files + 5 locale files + manifest

---

## 🔴 Critical

*No critical findings.*

---

## 🟡 Important

### S1 — `credentials: "include"` on cross-origin fetch

**File:** `src/background/service-worker.js:815` — `const response = await fetch(srcUrl, { credentials: "include" });`

**Severity:** 🟡 Important  
**Lens:** Security  
**Verification:** Verified

The extension fetches images with `credentials: "include"`, which sends cookies and HTTP auth headers with cross-origin requests. This is intentional for accessing authenticated images (e.g., behind login walls), but creates a credential-forwarding surface:

- Any image URL the user right-clicks triggers a credentialed fetch to that origin
- Malicious pages could craft `<img>` tags pointing to attacker-controlled origins, causing the extension to send the user's cookies to those origins
- The `host_permissions: ["http://*/*", "https://*/*"]` grants cross-origin access, amplifying the blast radius

**Recommendation:** Consider adding a user-visible warning or restricting `credentials: "include"` to same-origin requests only. If cross-origin authenticated images are required, document the security trade-off.

---

## 🔵 Suggestions

### Q1 — `innerHTML` usage with escaped content

**File:** `src/options/options.js:123,128,134,140-143` — `historyList.innerHTML = ...`

**Severity:** 🔵 Suggestion  
**Lens:** Quality  
**Verification:** Verified

The `renderHistory()` function uses `innerHTML` to render history items. All user-controlled values (`finalPath`, `error`, timestamps) are properly escaped via `escapeHtml()`, which handles `&`, `<`, `>`, `"`, `'`. Translation strings come from bundled locale files, not user input.

**Risk:** Low — the escaping is correct. However, `innerHTML` with template literals is fragile; future changes could accidentally introduce unescaped interpolation.

**Recommendation:** Consider using DOM APIs (`createElement`, `textContent`) for the history list rendering to eliminate the XSS surface entirely.

---

### Q2 — Offscreen document lifecycle management

**File:** `src/lib/clipboard.js:19-27` — `offscreenPromise` singleton pattern

**Severity:** 🔵 Suggestion  
**Lens:** Quality  
**Verification:** Verified

The offscreen document creation uses a promise-based singleton pattern. If `chrome.offscreen.createDocument` fails (e.g., document already exists from another extension instance), the promise rejects and `offscreenPromise` is set to `null` via `.finally()`. This allows retry, but:

- Race condition: two concurrent calls could both see `offscreenPromise === null` and both attempt creation
- The second call would fail with "document already exists"

**Current mitigation:** The `getOffscreenContexts()` check before creation reduces the window, but doesn't eliminate it.

**Recommendation:** Add error handling in `ensureOffscreenDocument()` to catch "already exists" errors gracefully.

---

### Q3 — Screenshot size validation edge case

**File:** `src/background/service-worker.js:519-527` — `validateScreenshotSize()`

**Severity:** 🔵 Suggestion  
**Lens:** Quality  
**Verification:** Verified

The validation checks `width * height > MAX_SCREENSHOT_PIXELS` (100M pixels). For extremely tall or wide pages, the multiplication could exceed `Number.MAX_SAFE_INTEGER` before the check fires, though this is unlikely in practice (would require dimensions > 9.5 petapixels).

**Recommendation:** No action required — this is theoretical. The `MAX_SCREENSHOT_EDGE` (32767) check provides practical protection.

---

### Q4 — `execCommand('copy')` fallback is deprecated

**File:** `src/offscreen/offscreen.js:64-74` — `document.execCommand('copy')`

**Severity:** 🔵 Suggestion  
**Lens:** Quality  
**Verification:** Verified

The `writeText()` function falls back to `document.execCommand('copy')` if `navigator.clipboard.writeText()` fails. `execCommand` is deprecated and may be removed in future Chrome versions.

**Current behavior:** The primary path uses the modern Clipboard API; the fallback only activates if the modern API throws (e.g., in older Chrome versions or restricted contexts).

**Recommendation:** Monitor Chrome deprecation timeline; consider removing the fallback when minimum Chrome version exceeds 114 (where Clipboard API is stable).

---

### Q5 — Magic number for capture interval

**File:** `src/background/service-worker.js:10` — `const CAPTURE_INTERVAL_MS = 550;`

**Severity:** 🔵 Suggestion  
**Lens:** Quality  
**Verification:** Verified

The 550ms interval between screenshot captures is undocumented. This appears to be a throttle to avoid overwhelming `captureVisibleTab`, but the rationale isn't explained.

**Recommendation:** Add a comment explaining why 550ms was chosen (rate limiting? rendering stability?).

---

## 💭 Discussion

### D1 — Broad host permissions

**File:** `manifest.json:14-16` — `"host_permissions": ["http://*/*", "https://*/*", "file:///*"]`

The extension requests access to all HTTP, HTTPS, and file:// URLs. This is necessary for the core functionality (saving images from any page), but:

- Chrome Web Store reviewers flag broad permissions
- Users see a warning during installation
- Alternative: use `activeTab` permission (already declared) with `scripting` to inject on-demand

**Trade-off:** `activeTab` would require user gesture for each page; the current design allows background image fetching without user interaction. The broad permissions are justified for this use case, but worth documenting.

---

### D2 — No Content Security Policy

**File:** `manifest.json` (absent)

The extension doesn't declare a Content Security Policy. Chrome MV3 applies a default CSP (`script-src 'self'; object-src 'self'`), which is sufficient. However, explicitly declaring a CSP would:

- Document the security posture
- Allow tightening (e.g., disallowing `eval` if not needed)
- Pass automated security scanners

**Recommendation:** Consider adding an explicit CSP to `manifest.json` for documentation and defense-in-depth.

---

## Precedents

*No prior reviews found in `.rpiv/artifacts/reviews/`.*

---

## Recommendation

The extension is well-structured with proper input escaping, error handling, and i18n support. The main security consideration is the `credentials: "include"` pattern on cross-origin fetches, which is a design trade-off for authenticated image access rather than a bug.

**No blockers.** The codebase is production-ready with the noted suggestions.

---

## Pattern Analysis

### Peer Consistency

The extension maintains good consistency across its modules:

- All locale files have identical key sets (5 locales verified)
- Settings normalization is centralized in `settings.js`
- Error messages use i18n consistently

### Code Organization

Clean separation of concerns:

- `service-worker.js`: Business logic and Chrome API orchestration
- `lib/`: Reusable utilities (clipboard, i18n, settings, file naming)
- `offscreen/`: Clipboard isolation (required by Chrome MV3)
- `options/`: Settings UI

---

*Generated by code-review skill on 2026-07-12*
