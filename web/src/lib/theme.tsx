import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
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

const ThemeContext = createContext<ThemeContextValue | null>(null);

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
          text: "#e8edf6",
          axis: "#7d899e",
          split: "#1e293b",
          tooltipBg: "rgba(14, 21, 34, 0.96)",
          tooltipBorder: "#2b3a51",
          area: "rgba(52, 211, 153, 0.14)",
        }
      : {
          text: "#12161f",
          axis: "#7b8496",
          split: "#eef1f5",
          tooltipBg: "rgba(255, 255, 255, 0.98)",
          tooltipBorder: "#e6e9ee",
          area: "rgba(22, 163, 74, 0.12)",
        },
  }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
