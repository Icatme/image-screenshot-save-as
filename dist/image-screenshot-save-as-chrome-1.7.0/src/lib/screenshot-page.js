export function preparePageForScreenshot(recoveryTimeoutMs) {
	const doc = document.documentElement;
	const body = document.body;
	const recoveryStateAttribute = "data-img-save-as-capture-recovery";
	restoreStoredCaptureState();
	const recoveryToken = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
	const scrollingElement = document.scrollingElement || doc;
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	const pageHeight = Math.max(
		scrollingElement.scrollHeight,
		doc.scrollHeight,
		body?.scrollHeight || 0,
		doc.offsetHeight,
		body?.offsetHeight || 0,
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
		const elementTop = Math.max(0, Math.min(viewportHeight, rect.top));
		const elementBottom = Math.max(
			elementTop,
			Math.min(viewportHeight, rect.bottom),
		);
		const elementViewportHeight = Math.min(
			scrollElement.clientHeight,
			Math.max(1, elementBottom - elementTop),
		);

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

		if (storedState.scrollTarget === "element") {
			const target = document.querySelector(
				`[data-img-save-as-scroll-target="${storedState.targetId}"]`,
			);
			if (target) {
				target.style.scrollBehavior =
					storedState.originalTargetScrollBehavior || "";
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

	function findMainScrollElement(width, height) {
		const elements = Array.from(document.body?.querySelectorAll("*") || []);
		let bestElement = null;
		let bestScore = 0;

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
			const visibleWidth = Math.min(width, rect.right) - Math.max(0, rect.left);
			const visibleHeight =
				Math.min(height, rect.bottom) - Math.max(0, rect.top);
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
		return storedState.recoveryToken === state.recoveryToken;
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

	if (state.scrollTarget === "element") {
		const target = document.querySelector(
			`[data-img-save-as-scroll-target="${state.targetId}"]`,
		);
		if (target) {
			target.style.scrollBehavior = state.originalTargetScrollBehavior || "";
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
}
