const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export function buildDownloadPath({ srcUrl, pageTitle, format }) {
  const ext = normalizeExtension(format);
  const imageName = sanitizeSegment(extractImageName(srcUrl) || "");
  const safeTitle = sanitizeSegment(pageTitle || "");
  const filenameStem = imageName || safeTitle || "image";

  return sanitizeFilename(`${filenameStem}.${ext}`, ext);
}

function normalizeExtension(format) {
  if (format === "jpg") {
    return "jpg";
  }

  if (format === "png" || format === "webp") {
    return format;
  }

  return "png";
}

function extractImageName(srcUrl) {
  if (!srcUrl || srcUrl.startsWith("data:") || srcUrl.startsWith("blob:")) {
    return "";
  }

  try {
    const url = new URL(srcUrl);
    const pathname = decodeURIComponent(url.pathname);
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    if (!lastSegment) {
      return "";
    }

    return lastSegment.replace(/\.[a-z0-9]{2,5}$/i, "");
  } catch {
    return "";
  }
}

function sanitizeSegment(value) {
  if (!value) {
    return "";
  }

  return sanitizeFilename(value)
    .replaceAll(".", "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function sanitizeFilename(value, ext = "") {
  const cleaned = String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .trim();

  const fallback = cleaned || "image";
  const basename = ext && fallback.toLowerCase().endsWith(`.${ext}`)
    ? fallback.slice(0, -1 * (ext.length + 1))
    : fallback;
  const safeBasename = WINDOWS_RESERVED_NAMES.has(basename.toLowerCase())
    ? `${basename}-file`
    : basename;
  const rebuilt = ext ? `${safeBasename}.${ext}` : safeBasename;

  return rebuilt.slice(0, 180) || `image.${ext || "png"}`;
}
