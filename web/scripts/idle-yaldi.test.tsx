import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { PreferencesProvider } from "../src/lib/preferences";
import { ThemeProvider } from "../src/lib/theme";
import { IDLE_POSES, IdleYaldi, wakeQuip } from "../src/components/IdleYaldi";

function render(hideArtwork: boolean) {
  const storage = { getItem: () => JSON.stringify({ version: 1, labsEnabled: false, hideArtwork }), setItem: () => {} };
  return renderToString(<QueryClientProvider client={new QueryClient()}><ThemeProvider><PreferencesProvider storage={storage}><IdleYaldi page="cost" /></PreferencesProvider></ThemeProvider></QueryClientProvider>);
}

describe("idle Yaldi", () => {
  test("is a real, labelled button around decorative art, and starts still", () => {
    const html = render(false);
    expect(html).toContain('aria-label="Wake Yaldi"');
    expect(html).toContain("<button");
    expect(html).toContain('alt=""');
    expect(html).toContain("state-resting");
    expect(html).not.toContain("data-moving");
  });

  test("disappears with Hide artwork", () => {
    expect(render(true)).toBe("");
  });

  test("never idles in the pose reserved for findings", () => {
    expect(IDLE_POSES).not.toContain("clue-found" as never);
    expect(IDLE_POSES).not.toContain("error");
  });

  test("quips are plain text, cycle, and sometimes know the page", () => {
    const said = Array.from({ length: 8 }, (_, index) => wakeQuip("cost", index));
    expect(said).toContain("Counting coins. Purely for evidence.");
    expect(new Set(said).size).toBeGreaterThan(2);
    expect(wakeQuip("usage", 1)).toBe(wakeQuip("overview", 1));
  });
});
