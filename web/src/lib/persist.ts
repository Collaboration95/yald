/**
 * The last successful response for each dashboard request, kept in this browser profile
 * (IndexedDB database `yald`, store `responses`), so a reload shows it at once, labelled
 * with the time it was saved, while a fresh request runs. Bodies are stored exactly as
 * parsed, so `null` (unavailable) stays `null`. Errors and demo data are never stored.
 * Entries carry the app build and a response version; any other version is discarded.
 */
import { DEMO } from "./demo";

declare const __YALD_BUILD__: string | undefined;

/** Bump when a response shape changes so that old bodies would render wrongly. */
export const RESPONSE_VERSION = 1;
export const MAX_ENTRIES = 40;
export const MAX_AGE_MS = 7 * 24 * 3_600_000;
/** A larger body is not worth keeping (characters of JSON text). */
export const MAX_ENTRY_SIZE = 3_000_000;
const DATABASE = "yald";
const STORE = "responses";

export interface SavedResponse {
  /** `<build>|<response version>|<url>` */
  key: string;
  url: string;
  savedAt: number;
  etag: string | null;
  size: number;
  body: unknown;
}

export const currentVersion = (): string => `${typeof __YALD_BUILD__ === "string" ? __YALD_BUILD__ : "dev"}|${RESPONSE_VERSION}`;
export const storageKey = (url: string, version = currentVersion()): string => `${version}|${url}`;

/** Which stored entries to keep: this version, younger than the age limit, the newest few. */
export function retain(entries: SavedResponse[], now: number, version = currentVersion()): { keep: SavedResponse[]; drop: string[] } {
  const fresh = entries
    .filter(entry => entry.key === storageKey(entry.url, version) && now - entry.savedAt <= MAX_AGE_MS && entry.savedAt <= now)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_ENTRIES);
  const kept = new Set(fresh.map(entry => entry.key));
  return { keep: fresh, drop: entries.filter(entry => !kept.has(entry.key)).map(entry => entry.key) };
}

const byUrl = new Map<string, SavedResponse>();
/** Bodies that came from storage, with the time each was saved. */
const savedAt = new WeakMap<object, number>();
let database: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (DEMO || typeof indexedDB === "undefined") return Promise.resolve(null);
  database ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "key" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return database;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise(resolve => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

/** Reads every saved response before the first render; at most `waitMs`, then the page starts without them. */
export async function loadSavedResponses(waitMs = 400): Promise<void> {
  const load = (async () => {
    const db = await open();
    if (!db) return;
    const all = await new Promise<SavedResponse[]>(resolve => {
      try {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result as SavedResponse[]);
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    const drop = adoptSavedResponses(all, Date.now());
    if (drop.length) {
      const transaction = db.transaction(STORE, "readwrite");
      for (const key of drop) transaction.objectStore(STORE).delete(key);
      await done(transaction);
    }
  })();
  await Promise.race([load, new Promise(resolve => setTimeout(resolve, waitMs))]);
}

/** Makes the stored entries worth keeping available to this page load; returns the keys to delete. */
export function adoptSavedResponses(entries: SavedResponse[], now: number): string[] {
  const { keep, drop } = retain(entries, now);
  for (const entry of keep) {
    byUrl.set(entry.url, entry);
    if (entry.body !== null && typeof entry.body === "object") savedAt.set(entry.body, entry.savedAt);
  }
  return drop;
}

/** The saved response for this exact request URL, if any. Never in demo mode. */
export function savedResponse(url: string): SavedResponse | undefined {
  return DEMO ? undefined : byUrl.get(url);
}

/** When this exact body object was loaded from storage, the time it was saved. */
export function savedTime(body: unknown): number | undefined {
  return body !== null && typeof body === "object" ? savedAt.get(body) : undefined;
}

/** Keeps a successful response. Callers pass only 2xx bodies; demo data is never stored. */
export function saveResponse(url: string, body: unknown, etag: string | null, size: number): void {
  if (DEMO || size > MAX_ENTRY_SIZE) return;
  const entry: SavedResponse = { key: storageKey(url), url, savedAt: Date.now(), etag, size, body };
  byUrl.set(url, entry);
  void (async () => {
    const db = await open();
    if (!db) return;
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(entry);
      await done(transaction);
      if (byUrl.size > MAX_ENTRIES) {
        const oldest = [...byUrl.values()].sort((a, b) => a.savedAt - b.savedAt).slice(0, byUrl.size - MAX_ENTRIES);
        const evict = db.transaction(STORE, "readwrite");
        for (const stale of oldest) { byUrl.delete(stale.url); evict.objectStore(STORE).delete(stale.key); }
        await done(evict);
      }
    } catch {
      // Persistence is best effort: a full or blocked store only costs the next reload its head start.
    }
  })();
}
