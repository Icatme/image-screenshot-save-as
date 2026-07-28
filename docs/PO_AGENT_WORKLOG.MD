# PO Agent Worklog

## 2026-07-07

- Added page screenshot context-menu flows for visible-page and full-page capture, with PNG/JPG/WebP export and save/copy-path actions.
- Reused the existing local download, conversion, clipboard, and history storage paths; full-page screenshots use scroll-and-stitch capture without adding third-party libraries or `debugger` permission.
- Updated extension permissions, locale strings, README, and design notes for the screenshot feature and its size/switch-tab limits.
- Fixed review findings by rechecking the active tab immediately before capture after throttling waits, syncing screenshot-related files into the unpacked `dist` package, and rebuilding `dist/img-save-as-chrome-1.0.0.zip`.
- Fixed full-page screenshots on pages whose primary scroll area is an app/root scroll container instead of `window/document`; the capture now detects a main scrollable element, scrolls it, stitches only the newly exposed content region, syncs `dist`, and rebuilds the ZIP.
- Fixed repeated screenshot saves where Chrome could immediately cancel the `saveAs` dialog request after a prior screenshot; screenshot downloads now retry once without the save dialog and fall back to the default Downloads location, with `dist` and the ZIP rebuilt.
- Added `file:///*` host permission plus runtime checks for Chrome's file URL access toggle, and routed local image reads through page extraction instead of background `fetch(file://...)`; updated docs, locales, `dist`, and the ZIP.
- Renamed the public extension identity from `Img Save As` to `Image & Screenshot Save As` so the displayed name covers both image conversion saves and page screenshot saves; internal menu IDs were left unchanged.
- Added an MIT license and README license section for public open-source publication.
- Created the public GitHub repository `Icatme/image-screenshot-save-as` and pushed the project on the `main` branch.
- Prepared version `1.5` for GitHub release, renamed the packaged artifact to `image-screenshot-save-as-chrome-1.5.zip`, and published release tag `v1.5`.

## 2026-07-28

- Completed the version `1.6` reliability pass: preserved WebP alpha, removed the implicit save-dialog-to-silent-download fallback, localized stable image/download failures, and bounded source fetches and image dimensions.
- Reworked MV3 state around per-download session records, serialized/idempotent history and activity writes, cold-start initialization, screenshot leases and persisted capture throttling, document-bound page recovery, trusted storage access, and chunked offscreen Blob transfer beyond the single-message size limit.
- Improved the settings/history UI with visible errors, queued snapshot-based automatic saves, recent activity, confirmed serialized history clearing, semantic list/dialog markup, accessible feedback/focus states, responsive ordering, system notifications, and removal of persisted source URL/page-title metadata.
- Split page-capture DOM logic and bounded image-source acquisition out of the service worker, reducing it from 1,364 to 1,126 lines while keeping injected functions self-contained and making file URL checks fail closed.
- Added Node contract/unit tests, a required real-Chrome extension/WebP smoke test, dependency audit, Windows CI, LF-normalized release inputs, and deterministic PowerShell packaging/verification. Final checks passed with 35 unit/contract tests and 1 Chrome smoke test; the 28-file `image-screenshot-save-as-chrome-1.6.zip` reproduced SHA256 `d2e3c791df3a2911a00faf2bab586057f5bf9c53c9a1d5716faa97138c217992` across two builds.
