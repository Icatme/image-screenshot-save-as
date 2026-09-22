import { buildScreenshotPageFilename } from "./file-name.js";

const DATABASE_NAME = "screenshot-save-directory";
const STORE_NAME = "directories";
const DIRECTORY_KEY = "screenshot";

export async function loadScreenshotDirectory() {
  return useDirectoryStore("readonly", (store) => store.get(DIRECTORY_KEY));
}

export async function storeScreenshotDirectory(handle) {
  requireDirectory(handle);
  await useDirectoryStore("readwrite", (store) => store.put(handle, DIRECTORY_KEY));
}

export async function createScreenshotDirectorySink({ directory, filename }) {
  requireDirectory(directory);
  const firstFilename = buildScreenshotPageFilename(filename, 1);
  const [, originalStem, extension] = /^(.*)-001\.(png|jpg|webp)$/.exec(firstFilename);
  // File System Access has no exclusive-create operation. Give each batch a
  // fresh namespace instead of racing for predictable incrementing filenames.
  const suffix = `-${crypto.randomUUID()}`;
  const stem = originalStem.slice(0, 80 - suffix.length).replace(/-+$/, "");
  const batchFilename = `${stem}${suffix}.${extension}`;

  let pending = Promise.resolve();
  return {
    pageFilename({ index, partial = false }) {
      return buildScreenshotPageFilename(batchFilename, index, partial);
    },
    savePage(page) {
      // Keep one writable stream open at a time, including concurrent callers.
      // A failed page stops this batch; later calls retain the original failure.
      pending = pending.then(() => savePage(directory, batchFilename, page));
      return pending;
    },
  };
}

async function savePage(directory, batchFilename, { blob, index, partial = false }) {
  const filename = buildScreenshotPageFilename(batchFilename, index, partial);
  await requireMissingFile(directory, filename);
  const handle = await directory.getFileHandle(filename, { create: true });
  const initialFile = await handle.getFile();
  if (initialFile.size !== 0) throw fileConflict(filename);
  let writable;
  try {
    writable = await handle.createWritable();
    await requireUnchangedFile(handle, initialFile, filename);
    await writable.write(blob);
    await requireUnchangedFile(handle, initialFile, filename);
    await writable.close();
  } catch (error) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // An already errored/closed stream can reject abort. Preserve the write error.
      }
    }
    throw error;
  }
  return filename;
}

async function requireMissingFile(directory, filename) {
  try {
    await directory.getFileHandle(filename, { create: false });
  } catch (error) {
    if (error.name === "NotFoundError") {
      return;
    }
    throw error;
  }
  throw fileConflict(filename);
}

async function requireUnchangedFile(handle, initialFile, filename) {
  const current = await handle.getFile();
  if (current.size !== initialFile.size || current.lastModified !== initialFile.lastModified) {
    throw fileConflict(filename);
  }
}

function fileConflict(filename) {
  return new DOMException(`Screenshot file already exists or changed: ${filename}`, "InvalidModificationError");
}

function requireDirectory(handle) {
  if (handle?.kind !== "directory") {
    throw new TypeError("A screenshot destination must be a directory handle.");
  }
}

async function useDirectoryStore(mode, operation) {
  const database = await openDirectoryDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(transaction.error || request.error || new Error("Directory storage transaction was aborted."));
      transaction.onerror = () => reject(transaction.error || request.error || new Error("Directory storage transaction failed."));
    });
  } finally {
    database.close();
  }
}

function openDirectoryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
