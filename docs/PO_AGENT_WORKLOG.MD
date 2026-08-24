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
- Followed up with version `1.6.1`: Chrome Web Store image fallback and full-page capture now prefer the context-menu event URL, stop before Chrome's forbidden script injection, and return a localized workaround, while notification icons resolve from an absolute extension URL instead of failing image download. Final checks passed with 40 unit/contract tests and 1 required real-Chrome smoke test; the 29-file ZIP reproduced SHA256 `d4c3ace9c24f39cd30b3e5f5bf694df0feda80273fad50296b3358ac31a2e17c` across two builds.
- Changed GitHub Actions CI from automatic push/PR execution to manual `workflow_dispatch` execution while retaining the existing verification steps.

## 2026-07-30

- Added a current-viewport rectangular screenshot mode with an isolated drag-selection overlay, cancel/timeout cleanup, device-scale-aware cropping, PNG/JPG/WebP export, localized menus/instructions, and shared download/history handling.
- Review hardening moved the selector into a CSS-isolated Top Layer dialog, consumes trusted keyboard/right-click/click input through the complete browser event sequence, survives ancestor capture listeners that stop propagation, and waits for a post-removal painted frame before capture so the selection border cannot enter the result.
- Verification passed with 44 Node unit/contract tests, 1 required real-Chrome smoke test covering a pre-existing modal, trusted input suppression, selection, cancellation, and border-free bitmap cropping, plus release verification for the 30-file package with SHA256 `e5e825a9f3d253b8acece1f7ce9b69e965ffbd0c97289f4382463fa4dfea3cfd` and a clean `git diff --check`.
- Follow-up review fixes preserve any page-owned element that shares the selector ID and map crop coordinates through the visual viewport under pinch zoom. Verification passed with 45 Node unit/contract tests and 1 required real-Chrome smoke test; two release builds reproduced SHA256 `a20aabca275e63808ba8e69b752fc79d00cd0e546bf049e06a3d3ff302f0ded5`.
- Bumped the extension and package metadata to `1.7.0` for the rectangular screenshot feature and fixes, replaced the stale `1.6.1` distribution artifacts, and reproduced the 30-file ZIP with SHA256 `7f400d240c46fb511c524cf77936fed4397158b10b6c706e1418fecb1593dc1e` across two builds.

## 2026-08-05

- Fixed full-page capture stalling at the bottom of pages whose body height rounded one pixel above the fractional root scroll extent; root capture metrics now come from the actual scrolling element and preserve its fractional layout height. Added a real-Chrome regression check, passed 45 unit/contract tests and the required browser smoke test, and rebuilt the verified 30-file `image-screenshot-save-as-chrome-1.7.0.zip` with SHA256 `f5b2ff152cd90a26ac0906b6cd31d5e075134334513ab1fb75305fcc38b4c1f7`.
- Changed full-page failure handling so scroll stalls, tab switches, and page interruptions save any already-stitched canvas as a localized partial screenshot; failures before the first completed viewport still fail without creating an empty download. Partial state now survives pending-download recovery and appears in save history. Verification passed with 46 unit/contract tests, the required real-Chrome smoke test, and the verified 30-file ZIP SHA256 `aefbc2b585f6418cd4839b967670aef8d2a7c4be8dd4462706dea35b6aed23de`.

## 2026-08-23

- Fixed long screenshots at the source: exports crop unpainted canvas tails, partial files append `-partial` and persist stable reason/progress, and the UI presents them as warnings. Main-scroll detection now rejects ancestor-clipped/scaled containers, disables and restores scroll snap, and stops when SPA replacement removes the target; real-DOM regressions cover each boundary.
- Isolated per-download recovery failures and made Blob URL cleanup a persisted cleanup-only phase retried on later worker wakeups. The offscreen owner now polls the worker for authorization and reaps only URLs whose matching records are cleanup-only, preserving active downloads without adding permissions.
- Restricted release packaging to the four manifest runtime icons and verified both package-lock version fields. Final gates passed with 58 Node tests, 1 required real-Chrome smoke test, and a verified 27-file ZIP reproduced twice at SHA256 `e4fbf0171a8414e0469c2c515ec153b0f001d521d0f7c671aa35da7a99986a5e`; `npm audit` reported zero vulnerabilities.

## 2026-08-24

- Bumped the extension and package metadata to `1.8.0`, replaced the `1.7.0` distribution artifacts, and verified the final 27-file package after 58 Node tests and 1 required real-Chrome smoke test. Two release builds reproduced ZIP SHA256 `7c540370ed239ebf0b5f72f421cdae90bd0af3cce084b60cd9cfe99e457279a8`.
