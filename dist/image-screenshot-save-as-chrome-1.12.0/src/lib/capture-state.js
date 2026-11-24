const ACTIVE_SCREENSHOT_KEY = "activeScreenshot";
const LAST_CAPTURE_AT_KEY = "lastScreenshotCaptureAt";
let leaseMutationQueue = Promise.resolve();
let captureRateQueue = Promise.resolve();

export function acquireScreenshotLease(nextLease) {
	return mutateLease(async (currentLease) => {
		if (currentLease?.workerId === nextLease.workerId) {
			return {
				result: { acquired: false, currentLease },
				nextLease: currentLease,
			};
		}

		return {
			result: {
				acquired: true,
				previousLease: currentLease || null,
				currentLease: nextLease,
			},
			nextLease,
		};
	});
}

export function updateScreenshotLease(workerId, updates) {
	return mutateLease(async (currentLease) => {
		if (!currentLease || currentLease.workerId !== workerId) {
			return { result: false, nextLease: currentLease };
		}

		return {
			result: true,
			nextLease: { ...currentLease, ...updates },
		};
	});
}

export function releaseScreenshotLease(workerId) {
	return mutateLease(async (currentLease) => {
		if (!currentLease || currentLease.workerId !== workerId) {
			return { result: false, nextLease: currentLease };
		}

		return { result: true, nextLease: null };
	});
}

export function takeStaleScreenshotLease(workerId) {
	return mutateLease(async (currentLease) => {
		if (!currentLease || currentLease.workerId === workerId) {
			return { result: null, nextLease: currentLease };
		}

		return { result: currentLease, nextLease: null };
	});
}

export async function getScreenshotLease() {
	await leaseMutationQueue.catch(() => {});
	const stored = await chrome.storage.session.get(ACTIVE_SCREENSHOT_KEY);
	return stored[ACTIVE_SCREENSHOT_KEY] || null;
}

export function waitForScreenshotCaptureSlot(minimumIntervalMs) {
	const operation = captureRateQueue.catch(() => {}).then(async () => {
		const stored = await chrome.storage.session.get(LAST_CAPTURE_AT_KEY);
		const lastCaptureAt = Number(stored[LAST_CAPTURE_AT_KEY]) || 0;
		const waitTime = Math.max(
			0,
			Number(minimumIntervalMs) - (Date.now() - lastCaptureAt),
		);
		if (waitTime > 0) {
			await new Promise((resolve) => setTimeout(resolve, waitTime));
		}

		const reservedAt = Date.now();
		await chrome.storage.session.set({ [LAST_CAPTURE_AT_KEY]: reservedAt });
		return reservedAt;
	});

	captureRateQueue = operation;
	return operation;
}

function mutateLease(operation) {
	const current = leaseMutationQueue.catch(() => {}).then(async () => {
		const stored = await chrome.storage.session.get(ACTIVE_SCREENSHOT_KEY);
		const currentLease = stored[ACTIVE_SCREENSHOT_KEY] || null;
		const { result, nextLease } = await operation(currentLease);

		if (nextLease) {
			await chrome.storage.session.set({ [ACTIVE_SCREENSHOT_KEY]: nextLease });
		} else {
			await chrome.storage.session.remove(ACTIVE_SCREENSHOT_KEY);
		}

		return result;
	});

	leaseMutationQueue = current;
	return current;
}
