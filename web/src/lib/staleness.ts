import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Mounted queries that are showing another selection's response while their own loads
 * (React Query placeholder data). The layout marks the page as not yet updated while any are.
 */
let placeholders = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) listener();
}

/** Counts this query while `showingPlaceholder` is true. */
export function useMarkPlaceholder(showingPlaceholder: boolean): void {
  useEffect(() => {
    if (!showingPlaceholder) return;
    placeholders++;
    notify();
    return () => {
      placeholders--;
      notify();
    };
  }, [showingPlaceholder]);
}

/** True while any mounted query shows a previous selection's numbers. */
export function usePlaceholderShown(): boolean {
  return useSyncExternalStore(subscribe, () => placeholders > 0, () => false);
}

/** Mounted queries showing a response saved by an earlier page load: when it was saved, and whether its refresh failed. */
const saved = new Map<symbol, { savedAt: number; failed: boolean }>();

/** Counts this query while it shows a saved response (`savedAt`), until fresh data replaces it. */
export function useMarkSaved(savedAt: number | null, failed: boolean): void {
  const [id] = useState(() => Symbol("saved"));
  useEffect(() => {
    if (savedAt === null) return;
    saved.set(id, { savedAt, failed });
    notify();
    return () => {
      saved.delete(id);
      notify();
    };
  }, [id, savedAt, failed]);
}

/** The oldest saved response on screen and whether any refresh failed; a string snapshot so it compares by value. */
function savedSnapshot(): string {
  if (!saved.size) return "";
  const entries = [...saved.values()];
  return `${Math.min(...entries.map(entry => entry.savedAt))}:${entries.some(entry => entry.failed) ? 1 : 0}`;
}

export function useSavedShown(): { savedAt: number; failed: boolean } | null {
  const snapshot = useSyncExternalStore(subscribe, savedSnapshot, () => "");
  if (!snapshot) return null;
  const [savedAt, failed] = snapshot.split(":");
  return { savedAt: Number(savedAt), failed: failed === "1" };
}
