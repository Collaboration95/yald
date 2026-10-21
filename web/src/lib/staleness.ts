import { useEffect, useSyncExternalStore } from "react";

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
