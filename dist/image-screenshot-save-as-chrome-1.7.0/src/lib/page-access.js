const EXTENSION_GALLERY_HOSTS = new Set([
	"chromewebstore.google.com",
	"chrome.google.com",
]);

export function isExtensionGalleryUrl(value) {
	if (typeof value !== "string" || !value) {
		return false;
	}

	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return false;
		}
		if (!EXTENSION_GALLERY_HOSTS.has(url.hostname.toLowerCase())) {
			return false;
		}

		return (
			url.hostname.toLowerCase() === "chromewebstore.google.com" ||
			url.pathname === "/webstore" ||
			url.pathname.startsWith("/webstore/")
		);
	} catch {
		return false;
	}
}
