import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

export interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  chartTheme: {
    text: string;
    axis: string;
    split: string;
    tooltipBg: string;
    tooltipBorder: string;
    area: string;
  };
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "yald-theme";
const LEGACY_STORAGE_KEY = "ocx-observatory-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === "dark" || legacy === "light") {
      localStorage.setItem(STORAGE_KEY, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return legacy;
    }
  } catch {
    // Private mode or blocked storage: fall through to the OS preference.
  }
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persisting the choice is best-effort.
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme(current => (current === "dark" ? "light" : "dark")), []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    toggle,
    chartTheme: theme === "dark"
      ? {
          text: "#eee9e2",
          axis: "#b9b6b2",
          split: "#474743",
          tooltipBg: "#302f2c",
          tooltipBorder: "#57554f",
          area: "rgba(82,106,203,.1)",
        }
      : {
          text: "#29292b",
          axis: "#69696c",
          split: "#e5e5e2",
          tooltipBg: "#ffffff",
          tooltipBorder: "#d5d5d1",
          area: "rgba(82,106,203,.1)",
        },
  }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
