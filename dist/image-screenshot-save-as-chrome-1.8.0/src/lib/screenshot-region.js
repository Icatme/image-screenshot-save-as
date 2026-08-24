export function selectScreenshotRegion(labels = {}, timeoutMs = 120_000) {
	const overlayIdPrefix = "img-save-as-region-selector";
	const cleanupKey = "__imgSaveAsRegionSelectorCleanup__";
	const minimumSize = 2;
	const instruction =
		typeof labels.instruction === "string" && labels.instruction
			? labels.instruction
			: "Drag to select an area. Press Esc or right-click to cancel.";

	if (typeof window[cleanupKey] === "function") {
		window[cleanupKey]();
	}
	let overlayId = overlayIdPrefix;
	let overlaySuffix = 1;
	while (document.getElementById(overlayId)) {
		overlayId = `${overlayIdPrefix}-${overlaySuffix}`;
		overlaySuffix += 1;
	}

	return new Promise((resolve) => {
		const host = document.createElement("dialog");
		host.id = overlayId;
		host.setAttribute("aria-modal", "true");
		host.setAttribute("aria-label", instruction);
		host.style.setProperty("all", "initial", "important");
		host.style.setProperty("position", "fixed", "important");
		host.style.setProperty("inset", "0", "important");
		host.style.setProperty("z-index", "2147483647", "important");
		host.style.setProperty("display", "block", "important");
		host.style.setProperty("box-sizing", "border-box", "important");
		host.style.setProperty("width", "100vw", "important");
		host.style.setProperty("height", "100vh", "important");
		host.style.setProperty("max-width", "none", "important");
		host.style.setProperty("max-height", "none", "important");
		host.style.setProperty("margin", "0", "important");
		host.style.setProperty("padding", "0", "important");
		host.style.setProperty("border", "0", "important");
		host.style.setProperty("outline", "0", "important");
		host.style.setProperty("overflow", "hidden", "important");
		host.style.setProperty("cursor", "crosshair", "important");
		host.style.setProperty("user-select", "none", "important");
		host.style.setProperty("touch-action", "none", "important");
		host.style.setProperty("background", "rgba(8, 15, 30, 0.46)", "important");

		const backdropStyle = document.createElement("style");
		backdropStyle.textContent = `
			#${overlayId}::backdrop { background: transparent !important; }
		`;
		const surface = document.createElement("div");
		surface.style.setProperty("position", "fixed", "important");
		surface.style.setProperty("inset", "0", "important");
		surface.style.setProperty("display", "block", "important");
		surface.style.setProperty("pointer-events", "none", "important");
		const shadow = surface.attachShadow({ mode: "closed" });
		const style = document.createElement("style");
		style.textContent = `
			:host { all: initial; }
			.selection {
				position: fixed;
				display: none;
				box-sizing: border-box;
				border: 2px solid #38bdf8;
				border-radius: 2px;
				background: transparent;
				box-shadow: 0 0 0 99999px rgba(8, 15, 30, 0.46), 0 0 0 1px rgba(255, 255, 255, 0.9) inset;
				pointer-events: none;
			}
			.size {
				position: absolute;
				left: -2px;
				top: calc(100% + 8px);
				padding: 4px 7px;
				border-radius: 5px;
				background: #0f172a;
				color: #f8fafc;
				font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				letter-spacing: 0.01em;
				white-space: nowrap;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
			}
			.instruction {
				position: fixed;
				left: 50%;
				top: 18px;
				max-width: min(560px, calc(100vw - 32px));
				transform: translateX(-50%);
				box-sizing: border-box;
				padding: 9px 13px;
				border: 1px solid rgba(255, 255, 255, 0.2);
				border-radius: 8px;
				background: rgba(15, 23, 42, 0.94);
				color: #f8fafc;
				font: 600 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				text-align: center;
				box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
				pointer-events: none;
			}
		`;

		const selection = document.createElement("div");
		selection.className = "selection";
		const size = document.createElement("div");
		size.className = "size";
		selection.append(size);

		const message = document.createElement("div");
		message.className = "instruction";
		message.textContent = instruction;
		shadow.append(style, selection, message);
		host.append(backdropStyle, surface);
		(document.documentElement || document.body).append(host);
		host.showModal();

		let startX = 0;
		let startY = 0;
		let dragging = false;
		let settled = false;
		let currentRegion = null;
		let pendingResult = null;
		let completionTimeoutId = null;
		let escapeKeyPending = false;
		let escapeKeyUpTimeoutId = null;
		let activeViewport = null;

		const getVisualViewport = () => ({
			left: window.visualViewport?.offsetLeft ?? 0,
			top: window.visualViewport?.offsetTop ?? 0,
			width: window.visualViewport?.width ?? window.innerWidth,
			height: window.visualViewport?.height ?? window.innerHeight,
		});
		const clamp = (value, minimum, maximum) =>
			Math.max(minimum, Math.min(maximum, Number(value) || 0));
		const regionFromPoint = (
			clientX,
			clientY,
			viewport = activeViewport || getVisualViewport(),
		) => {
			const endX = clamp(
				clientX,
				viewport.left,
				viewport.left + viewport.width,
			);
			const endY = clamp(
				clientY,
				viewport.top,
				viewport.top + viewport.height,
			);
			return {
				x: Math.min(startX, endX),
				y: Math.min(startY, endY),
				width: Math.abs(endX - startX),
				height: Math.abs(endY - startY),
			};
		};
		const render = (region) => {
			currentRegion = region;
			host.style.setProperty("background", "transparent", "important");
			selection.style.display = "block";
			selection.style.left = `${region.x}px`;
			selection.style.top = `${region.y}px`;
			selection.style.width = `${region.width}px`;
			selection.style.height = `${region.height}px`;
			size.textContent = `${Math.round(region.width)} × ${Math.round(region.height)}`;
		};
		const stopEvent = (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		const removeListeners = (preserveEscapeKeyUp = false) => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("pointermove", onPointerMove, true);
			window.removeEventListener("pointerup", onPointerUp, true);
			window.removeEventListener("pointercancel", onPointerCancel, true);
			window.removeEventListener("contextmenu", onContextMenu, true);
			window.removeEventListener("click", onClick, true);
			window.removeEventListener("auxclick", onAuxClick, true);
			host.removeEventListener("cancel", onDialogCancel, true);
			host.removeEventListener("close", onDialogClose, true);
			window.removeEventListener("wheel", stopEvent, true);
			window.removeEventListener("dragstart", stopEvent, true);
			window.removeEventListener("selectstart", stopEvent, true);
			for (const eventName of blockedPointerEvents) {
				window.removeEventListener(eventName, stopEvent, true);
			}
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keypress", stopEvent, true);
			if (!preserveEscapeKeyUp) {
				window.removeEventListener("keyup", onKeyUp, true);
			}
			window.removeEventListener("resize", onResize, true);
			window.visualViewport?.removeEventListener("resize", onResize);
			window.visualViewport?.removeEventListener("scroll", onResize);
			document.removeEventListener("visibilitychange", onVisibilityChange, true);
		};
		const resolveAfterOverlayPaint = (result) => {
			if (result.cancelled) {
				resolve(result);
				return;
			}

			let resolved = false;
			let firstFrameId = null;
			let secondFrameId = null;
			const fallbackId = window.setTimeout(complete, 500);
			function complete() {
				if (resolved) {
					return;
				}
				resolved = true;
				window.clearTimeout(fallbackId);
				if (firstFrameId !== null) {
					window.cancelAnimationFrame(firstFrameId);
				}
				if (secondFrameId !== null) {
					window.cancelAnimationFrame(secondFrameId);
				}
				resolve(result);
			}

			firstFrameId = window.requestAnimationFrame(() => {
				secondFrameId = window.requestAnimationFrame(complete);
			});
		};
		const finish = (result, preserveEscapeKeyUp = false) => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timeoutId);
			window.clearTimeout(completionTimeoutId);
			if (!preserveEscapeKeyUp) {
				window.clearTimeout(escapeKeyUpTimeoutId);
			}
			removeListeners(preserveEscapeKeyUp);
			if (host.open) {
				host.close();
			}
			host.remove();
			if (window[cleanupKey] === cancel) {
				delete window[cleanupKey];
			}
			resolveAfterOverlayPaint(result);
		};
		const cancel = () => finish({ cancelled: true });
		const clearEscapeKeyUpGuard = () => {
			window.clearTimeout(escapeKeyUpTimeoutId);
			escapeKeyUpTimeoutId = null;
			escapeKeyPending = false;
			window.removeEventListener("keyup", onKeyUp, true);
		};
		const finishFromEscape = () => {
			if (settled) {
				return;
			}
			escapeKeyPending = true;
			window.clearTimeout(escapeKeyUpTimeoutId);
			escapeKeyUpTimeoutId = window.setTimeout(
				clearEscapeKeyUpGuard,
				10_000,
			);
			finish({ cancelled: true }, true);
		};
		const finishAfterCurrentInput = (result, delayMs = 0) => {
			pendingResult = result;
			window.clearTimeout(completionTimeoutId);
			completionTimeoutId = window.setTimeout(
				() => finish(pendingResult),
				delayMs,
			);
		};
		const onPointerDown = (event) => {
			stopEvent(event);
			if (event.button !== 0) {
				return;
			}

			dragging = true;
			activeViewport = getVisualViewport();
			startX = clamp(
				event.clientX,
				activeViewport.left,
				activeViewport.left + activeViewport.width,
			);
			startY = clamp(
				event.clientY,
				activeViewport.top,
				activeViewport.top + activeViewport.height,
			);
			render(regionFromPoint(event.clientX, event.clientY, activeViewport));
			try {
				host.setPointerCapture(event.pointerId);
			} catch {}
		};
		const onPointerMove = (event) => {
			stopEvent(event);
			if (!dragging) {
				return;
			}
			render(regionFromPoint(event.clientX, event.clientY));
		};
		const onPointerUp = (event) => {
			stopEvent(event);
			if (!dragging || event.button !== 0) {
				return;
			}
			dragging = false;
			const viewport = activeViewport || getVisualViewport();
			const region = regionFromPoint(event.clientX, event.clientY, viewport);
			render(region);

			if (region.width < minimumSize || region.height < minimumSize) {
				currentRegion = null;
				activeViewport = null;
				selection.style.display = "none";
				host.style.setProperty(
					"background",
					"rgba(8, 15, 30, 0.46)",
					"important",
				);
				return;
			}

			finishAfterCurrentInput({
				cancelled: false,
				x: region.x - viewport.left,
				y: region.y - viewport.top,
				width: region.width,
				height: region.height,
				viewportWidth: viewport.width,
				viewportHeight: viewport.height,
			});
		};
		const onPointerCancel = (event) => {
			stopEvent(event);
			if (!dragging) {
				return;
			}
			dragging = false;
			currentRegion = null;
			activeViewport = null;
			selection.style.display = "none";
			host.style.setProperty(
				"background",
				"rgba(8, 15, 30, 0.46)",
				"important",
			);
		};
		const onContextMenu = (event) => {
			stopEvent(event);
			finishAfterCurrentInput({ cancelled: true });
		};
		const onClick = (event) => {
			stopEvent(event);
			if (pendingResult) {
				finish(pendingResult);
			}
		};
		const onAuxClick = (event) => {
			stopEvent(event);
			finishAfterCurrentInput({ cancelled: true });
		};
		const onDialogCancel = (event) => {
			stopEvent(event);
			finishFromEscape();
		};
		const onDialogClose = () => cancel();
		const onKeyDown = (event) => {
			stopEvent(event);
			if (event.key === "Escape") {
				finishFromEscape();
			}
		};
		const onKeyUp = (event) => {
			if (!settled) {
				stopEvent(event);
				return;
			}
			if (event.key === "Escape" && escapeKeyPending) {
				stopEvent(event);
				clearEscapeKeyUpGuard();
			}
		};
		const onResize = () => {
			if (!currentRegion) {
				return;
			}
			dragging = false;
			currentRegion = null;
			activeViewport = null;
			selection.style.display = "none";
			host.style.setProperty(
				"background",
				"rgba(8, 15, 30, 0.46)",
				"important",
			);
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				cancel();
			}
		};

		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("pointermove", onPointerMove, true);
		window.addEventListener("pointerup", onPointerUp, true);
		window.addEventListener("pointercancel", onPointerCancel, true);
		window.addEventListener("contextmenu", onContextMenu, true);
		window.addEventListener("click", onClick, true);
		window.addEventListener("auxclick", onAuxClick, true);
		host.addEventListener("cancel", onDialogCancel, true);
		host.addEventListener("close", onDialogClose, true);
		window.addEventListener("wheel", stopEvent, {
			capture: true,
			passive: false,
		});
		window.addEventListener("dragstart", stopEvent, true);
		window.addEventListener("selectstart", stopEvent, true);
		const blockedPointerEvents = [
			"mousedown",
			"mousemove",
			"mouseup",
			"dblclick",
			"touchstart",
			"touchmove",
			"touchend",
		];
		for (const eventName of blockedPointerEvents) {
			window.addEventListener(eventName, stopEvent, {
				capture: true,
				passive: false,
			});
		}
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keypress", stopEvent, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("resize", onResize, true);
		window.visualViewport?.addEventListener("resize", onResize);
		window.visualViewport?.addEventListener("scroll", onResize);
		document.addEventListener("visibilitychange", onVisibilityChange, true);

		const timeoutId = window.setTimeout(
			cancel,
			Math.max(10_000, Number(timeoutMs) || 120_000),
		);
		window[cleanupKey] = cancel;
	});
}

export function getScreenshotRegionPixels(region, bitmapWidth, bitmapHeight) {
	const outputWidth = Math.trunc(Number(bitmapWidth));
	const outputHeight = Math.trunc(Number(bitmapHeight));
	const viewportWidth = Number(region?.viewportWidth);
	const viewportHeight = Number(region?.viewportHeight);
	const x = Number(region?.x);
	const y = Number(region?.y);
	const width = Number(region?.width);
	const height = Number(region?.height);

	if (
		!Number.isFinite(viewportWidth) ||
		viewportWidth <= 0 ||
		!Number.isFinite(viewportHeight) ||
		viewportHeight <= 0 ||
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!Number.isFinite(width) ||
		width <= 0 ||
		!Number.isFinite(height) ||
		height <= 0 ||
		!Number.isSafeInteger(outputWidth) ||
		outputWidth <= 0 ||
		!Number.isSafeInteger(outputHeight) ||
		outputHeight <= 0
	) {
		return null;
	}

	const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
	const left = clamp(x, viewportWidth);
	const top = clamp(y, viewportHeight);
	const right = clamp(x + width, viewportWidth);
	const bottom = clamp(y + height, viewportHeight);
	if (right <= left || bottom <= top) {
		return null;
	}

	const scaleX = outputWidth / viewportWidth;
	const scaleY = outputHeight / viewportHeight;
	const sourceX = Math.max(
		0,
		Math.min(outputWidth - 1, Math.round(left * scaleX)),
	);
	const sourceY = Math.max(
		0,
		Math.min(outputHeight - 1, Math.round(top * scaleY)),
	);
	const sourceRight = Math.max(
		sourceX + 1,
		Math.min(outputWidth, Math.round(right * scaleX)),
	);
	const sourceBottom = Math.max(
		sourceY + 1,
		Math.min(outputHeight, Math.round(bottom * scaleY)),
	);

	return {
		x: sourceX,
		y: sourceY,
		width: sourceRight - sourceX,
		height: sourceBottom - sourceY,
	};
}
