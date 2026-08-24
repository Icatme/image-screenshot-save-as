export function preparePageForScreenshot(recoveryTimeoutMs) {
	const doc = document.documentElement;
	const body = document.body;
	const recoveryStateAttribute = "data-img-save-as-capture-recovery";
	const scrollingElement = document.scrollingElement || doc;
	restoreStoredCaptureState();
	const recoveryToken = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	// scrollHeight is integer-rounded while the root rect preserves fractional
	// CSS pixels. Keep both measurements tied to the element window.scrollTo uses.
	const scrollingElementHeight = scrollingElement.getBoundingClientRect().height;
	const pageHeight = Math.max(
		scrollingElement.scrollHeight,
		scrollingElementHeight,
		viewportHeight,
	);
	const rootMaxScrollY = Math.max(0, pageHeight - viewportHeight);
	const scrollElement =
		rootMaxScrollY <= 1
			? findMainScrollElement(viewportWidth, viewportHeight)
			: null;

	if (scrollElement) {
		const rect = scrollElement.getBoundingClientRect();
		const targetId = `img-save-as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const hadTargetMarker = scrollElement.hasAttribute(
			"data-img-save-as-scroll-target",
		);
		const previousTargetMarker =
			scrollElement.getAttribute("data-img-save-as-scroll-target") || "";
		const elementTop = Math.max(
			0,
			Math.min(viewportHeight, rect.top + scrollElement.clientTop),
		);
		const elementViewportHeight = scrollElement.clientHeight;

		scrollElement.setAttribute("data-img-save-as-scroll-target", targetId);

		const state = {
			recoveryToken,
			scrollTarget: "element",
			targetId,
			hadTargetMarker,
			previousTargetMarker,
			originalScrollX: window.scrollX,
			originalScrollY: window.scrollY,
			originalTargetScrollTop: scrollElement.scrollTop,
			originalDocumentScrollBehavior: doc.style.scrollBehavior,
			originalBodyScrollBehavior: body?.style.scrollBehavior || "",
			originalTargetScrollBehavior: scrollElement.style.scrollBehavior,
			originalTargetScrollSnapType:
				scrollElement.style.getPropertyValue("scroll-snap-type"),
			originalTargetScrollSnapPriority:
				scrollElement.style.getPropertyPriority("scroll-snap-type"),
			viewportWidth,
			viewportHeight,
			pageHeight:
				viewportHeight +
				Math.max(0, scrollElement.scrollHeight - elementViewportHeight),
			maxScrollY: Math.max(
				0,
				scrollElement.scrollHeight - elementViewportHeight,
			),
			elementTop,
			elementViewportHeight,
			elementScrollHeight: scrollElement.scrollHeight,
			devicePixelRatio: window.devicePixelRatio || 1,
		};
		doc.setAttribute(recoveryStateAttribute, JSON.stringify(state));

		doc.style.scrollBehavior = "auto";
		if (body) {
			body.style.scrollBehavior = "auto";
		}

		scrollElement.style.scrollBehavior = "auto";
		scrollElement.style.setProperty("scroll-snap-type", "none", "important");
		scrollElement.scrollTop = 0;
		scheduleRecovery();
		return state;
	}

	const state = {
		recoveryToken,
		scrollTarget: "window",
		originalScrollX: window.scrollX,
		originalScrollY: window.scrollY,
		originalDocumentScrollBehavior: doc.style.scrollBehavior,
		originalBodyScrollBehavior: body?.style.scrollBehavior || "",
		originalScrollingElementScrollSnapType:
			scrollingElement.style.getPropertyValue("scroll-snap-type"),
		originalScrollingElementScrollSnapPriority:
			scrollingElement.style.getPropertyPriority("scroll-snap-type"),
		viewportWidth,
		viewportHeight,
		pageHeight,
		maxScrollY: rootMaxScrollY,
		devicePixelRatio: window.devicePixelRatio || 1,
	};
	doc.setAttribute(recoveryStateAttribute, JSON.stringify(state));

	doc.style.scrollBehavior = "auto";
	if (body) {
		body.style.scrollBehavior = "auto";
	}
	scrollingElement.style.setProperty("scroll-snap-type", "none", "important");

	window.scrollTo(state.originalScrollX, 0);
	scheduleRecovery();
	return state;

	function scheduleRecovery() {
		window.setTimeout(
			() => restoreStoredCaptureState(recoveryToken),
			Math.max(10_000, Number(recoveryTimeoutMs) || 120_000),
		);
	}

	function restoreStoredCaptureState(expectedRecoveryToken) {
		const serialized = doc.getAttribute(recoveryStateAttribute);
		if (!serialized) {
			return;
		}

		let storedState;
		try {
			storedState = JSON.parse(serialized);
		} catch {
			doc.removeAttribute(recoveryStateAttribute);
			return;
		}
		if (
			expectedRecoveryToken &&
			storedState.recoveryToken !== expectedRecoveryToken
		) {
			return;
		}

		doc.style.scrollBehavior = storedState.originalDocumentScrollBehavior || "";
		if (body) {
			body.style.scrollBehavior = storedState.originalBodyScrollBehavior || "";
		}
		if ("originalScrollingElementScrollSnapType" in storedState) {
			restoreInlineStyleProperty(
				scrollingElement,
				"scroll-snap-type",
				storedState.originalScrollingElementScrollSnapType,
				storedState.originalScrollingElementScrollSnapPriority,
			);
		}

		if (storedState.scrollTarget === "element") {
			const target = document.querySelector(
				`[data-img-save-as-scroll-target="${storedState.targetId}"]`,
			);
			if (target) {
				target.style.scrollBehavior =
					storedState.originalTargetScrollBehavior || "";
				if ("originalTargetScrollSnapType" in storedState) {
					restoreInlineStyleProperty(
						target,
						"scroll-snap-type",
						storedState.originalTargetScrollSnapType,
						storedState.originalTargetScrollSnapPriority,
					);
				}
				target.scrollTop = storedState.originalTargetScrollTop || 0;
				if (storedState.hadTargetMarker) {
					target.setAttribute(
						"data-img-save-as-scroll-target",
						storedState.previousTargetMarker || "",
					);
				} else {
					target.removeAttribute("data-img-save-as-scroll-target");
				}
			}
		}

		window.scrollTo(
			storedState.originalScrollX || 0,
			storedState.originalScrollY || 0,
		);
		doc.removeAttribute(recoveryStateAttribute);
	}

	function restoreInlineStyleProperty(element, property, value, priority) {
		if (value) {
			element.style.setProperty(property, value, priority || "");
		} else {
			element.style.removeProperty(property);
		}
	}

	function findMainScrollElement(width, height) {
		const elements = Array.from(document.body?.querySelectorAll("*") || []);
		let bestElement = null;
		let bestScore = 0;
		const visibilityTolerance = 1.5;

		for (const element of elements) {
			const scrollHeight = element.scrollHeight;
			const clientHeight = element.clientHeight;
			if (scrollHeight <= clientHeight + 16 || clientHeight <= 0) {
				continue;
			}

			const style = getComputedStyle(element);
			if (!/(auto|scroll|overlay)/.test(style.overflowY)) {
				continue;
			}

			const rect = element.getBoundingClientRect();
			// Stitching assumes scrollTop CSS pixels map one-to-one to captured
			// viewport pixels. Reject scaled/rotated candidates and any scrollport
			// that is clipped by the viewport or an overflow-clipping ancestor.
			if (
				Math.abs(rect.width - element.offsetWidth) > visibilityTolerance ||
				Math.abs(rect.height - element.offsetHeight) > visibilityTolerance ||
				(style.clipPath && style.clipPath !== "none")
			) {
				continue;
			}

			const visibleRect = getClippedVisibleRect(element, width, height);
			const scrollportLeft = rect.left + element.clientLeft;
			const scrollportTop = rect.top + element.clientTop;
			const scrollportRight = scrollportLeft + element.clientWidth;
			const scrollportBottom = scrollportTop + clientHeight;
			if (
				!visibleRect ||
				visibleRect.left > scrollportLeft + visibilityTolerance ||
				visibleRect.top > scrollportTop + visibilityTolerance ||
				visibleRect.right < scrollportRight - visibilityTolerance ||
				visibleRect.bottom < scrollportBottom - visibilityTolerance
			) {
				continue;
			}

			const visibleWidth = element.clientWidth;
			const visibleHeight = clientHeight;
			if (visibleWidth < width * 0.45 || visibleHeight < height * 0.35) {
				continue;
			}

			const score =
				visibleWidth * visibleHeight * (scrollHeight / clientHeight);
			if (score > bestScore) {
				bestScore = score;
				bestElement = element;
			}
		}

		return bestElement;

		function getClippedVisibleRect(element, viewportWidth, viewportHeight) {
			const visibleRect = {
				left: 0,
				top: 0,
				right: viewportWidth,
				bottom: viewportHeight,
			};

			for (
				let ancestor = element.parentElement;
				ancestor;
				ancestor = ancestor.parentElement
			) {
				const ancestorStyle = getComputedStyle(ancestor);
				if (
					ancestorStyle.clipPath &&
					ancestorStyle.clipPath !== "none"
				) {
					return null;
				}

				const contain = ancestorStyle.contain || "";
				const containsPaint = /(^|\s)(paint|strict|content)(\s|$)/.test(
					contain,
				);
				const clipsX =
					containsPaint ||
					/(auto|scroll|hidden|clip|overlay)/.test(ancestorStyle.overflowX);
				const clipsY =
					containsPaint ||
					/(auto|scroll|hidden|clip|overlay)/.test(ancestorStyle.overflowY);
				if (!clipsX && !clipsY) {
					continue;
				}

				const ancestorRect = ancestor.getBoundingClientRect();
				if (clipsX) {
					visibleRect.left = Math.max(
						visibleRect.left,
						ancestorRect.left + ancestor.clientLeft,
					);
					visibleRect.right = Math.min(
						visibleRect.right,
						ancestorRect.left + ancestor.clientLeft + ancestor.clientWidth,
					);
				}
				if (clipsY) {
					visibleRect.top = Math.max(
						visibleRect.top,
						ancestorRect.top + ancestor.clientTop,
					);
					visibleRect.bottom = Math.min(
						visibleRect.bottom,
						ancestorRect.top + ancestor.clientTop + ancestor.clientHeight,
					);
				}
			}

			return visibleRect;
		}
	}
}

export function scrollPageForScreenshot(state, scrollY) {
	const serialized = document.documentElement.getAttribute(
		"data-img-save-as-capture-recovery",
	);
	let storedState;
	try {
		storedState = serialized ? JSON.parse(serialized) : null;
	} catch {
		storedState = null;
	}
	if (!storedState || storedState.recoveryToken !== state.recoveryToken) {
		return { documentChanged: true };
	}

	const target =
		state.scrollTarget === "element"
			? document.querySelector(
					`[data-img-save-as-scroll-target="${state.targetId}"]`,
				)
			: null;
	if (state.scrollTarget === "element" && !target) {
		return { documentChanged: true };
	}

	if (target) {
		target.scrollTop = scrollY;
	} else {
		window.scrollTo(state.originalScrollX, scrollY);
	}

	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				window.setTimeout(() => {
					resolve({
						scrollX: window.scrollX,
						scrollY: target ? target.scrollTop : window.scrollY,
					});
				}, 80);
			});
		});
	});
}

export function isPagePreparedForScreenshot(state) {
	const serialized = document.documentElement.getAttribute(
		"data-img-save-as-capture-recovery",
	);
	if (!serialized) {
		return false;
	}

	try {
		const storedState = JSON.parse(serialized);
		if (storedState.recoveryToken !== state.recoveryToken) {
			return false;
		}
		if (state.scrollTarget !== "element") {
			return true;
		}

		return Boolean(
			document.querySelector(
				`[data-img-save-as-scroll-target="${state.targetId}"]`,
			),
		);
	} catch {
		return false;
	}
}

export function restorePageAfterScreenshot(state) {
	const doc = document.documentElement;
	const body = document.body;
	const serialized = doc.getAttribute("data-img-save-as-capture-recovery");
	if (!serialized) {
		return false;
	}

	let storedState;
	try {
		storedState = JSON.parse(serialized);
	} catch {
		doc.removeAttribute("data-img-save-as-capture-recovery");
		return false;
	}
	if (storedState.recoveryToken !== state.recoveryToken) {
		return false;
	}

	doc.style.scrollBehavior = state.originalDocumentScrollBehavior || "";

	if (body) {
		body.style.scrollBehavior = state.originalBodyScrollBehavior || "";
	}
	if ("originalScrollingElementScrollSnapType" in state) {
		restoreInlineStyleProperty(
			document.scrollingElement || doc,
			"scroll-snap-type",
			state.originalScrollingElementScrollSnapType,
			state.originalScrollingElementScrollSnapPriority,
		);
	}

	if (state.scrollTarget === "element") {
		const target = document.querySelector(
			`[data-img-save-as-scroll-target="${state.targetId}"]`,
		);
		if (target) {
			target.style.scrollBehavior = state.originalTargetScrollBehavior || "";
			if ("originalTargetScrollSnapType" in state) {
				restoreInlineStyleProperty(
					target,
					"scroll-snap-type",
					state.originalTargetScrollSnapType,
					state.originalTargetScrollSnapPriority,
				);
			}
			target.scrollTop = state.originalTargetScrollTop || 0;

			if (state.hadTargetMarker) {
				target.setAttribute(
					"data-img-save-as-scroll-target",
					state.previousTargetMarker || "",
				);
			} else {
				target.removeAttribute("data-img-save-as-scroll-target");
			}
		}
	}

	window.scrollTo(state.originalScrollX || 0, state.originalScrollY || 0);
	doc.removeAttribute("data-img-save-as-capture-recovery");
	return true;

	function restoreInlineStyleProperty(element, property, value, priority) {
		if (value) {
			element.style.setProperty(property, value, priority || "");
		} else {
			element.style.removeProperty(property);
		}
	}
}
