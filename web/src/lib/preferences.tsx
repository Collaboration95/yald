import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEMO } from "./demo";

export const PREFERENCES_STORAGE_KEY = DEMO ? "yald.demo.preferences" : "yald.preferences";
/** Shared with B02. Add preference fields here and in decodePreferences. */
export interface Preferences {
  labsEnabled: boolean;
  hideArtwork: boolean;
}
export type PreferenceKey = keyof Preferences;
export type PreferencesStorage = Pick<Storage, "getItem" | "setItem">;
interface PreferencesContextValue extends Preferences {
  setPreference: <K extends PreferenceKey>(key: K, value: Preferences[K]) => void;
}
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({ labsEnabled: false, hideArtwork: false });
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function decodePreferences(raw: string | null): Preferences {
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (!saved || typeof saved !== "object") return { ...DEFAULT_PREFERENCES };
    const values = saved as Record<string, unknown>;
    if (values.version !== 1) return { ...DEFAULT_PREFERENCES };
    return {
      labsEnabled: typeof values.labsEnabled === "boolean" ? values.labsEnabled : false,
      hideArtwork: typeof values.hideArtwork === "boolean" ? values.hideArtwork : false,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function browserStorage(): PreferencesStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function readPreferences(storage: PreferencesStorage | null): Preferences {
  try {
    const raw = storage?.getItem(PREFERENCES_STORAGE_KEY) ?? null;
    return DEMO && raw === null ? { ...DEFAULT_PREFERENCES, labsEnabled: true } : decodePreferences(raw);
  } catch { return { ...DEFAULT_PREFERENCES }; }
}

/** SSR uses defaults. Inject storage (or null for memory only) for isolated tests. */
export function PreferencesProvider({ children, storage }: { children: ReactNode; storage?: PreferencesStorage | null }) {
  const [adapter] = useState(() => storage === undefined ? browserStorage() : storage);
  const [preferences, update] = useState(() => readPreferences(adapter));
  const current = useRef(preferences);
  const setPreference = useCallback(<K extends PreferenceKey>(key: K, value: Preferences[K]) => {
    const next = { ...current.current, [key]: value };
    current.current = next;
    update(next);
    try { adapter?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, ...next })); } catch { /* In-memory choices still work. */ }
  }, [adapter]);

  useEffect(() => {
    if (typeof window === "undefined" || storage !== undefined) return;
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== adapter || (event.key !== null && event.key !== PREFERENCES_STORAGE_KEY)) return;
      const next = readPreferences(adapter);
      current.current = next;
      update(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [adapter, storage]);
  const value = useMemo(() => ({ ...preferences, setPreference }), [preferences, setPreference]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
