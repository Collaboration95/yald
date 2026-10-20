import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeContext, type ThemeContextValue } from "../src/lib/theme";
import { PreferencesProvider } from "../src/lib/preferences";
import { YaldiArtwork, YaldiFindingArtwork, YaldiMark } from "../src/components/YaldiArtwork";
import { Wordmark } from "../src/components/Wordmark";
import { InvestigationState, type InvestigationStateKind } from "../src/pages/labs/InvestigationState";

/** Providers for real-view SSR checks; these are never imported by production. */
export function YaldiSmokeProviders({ children, theme = "light", hideArtwork = false, labsEnabled = true }: {
  children: ReactNode; theme?: "light" | "dark"; hideArtwork?: boolean; labsEnabled?: boolean;
}) {
  const context: ThemeContextValue = { theme, toggle: () => {}, chartTheme: { text: "", axis: "", split: "", tooltipBg: "", tooltipBorder: "", area: "" } };
  return <ThemeContext.Provider value={context}><PreferencesProvider storage={{
    getItem: () => JSON.stringify({ version: 1, labsEnabled, hideArtwork }), setItem: () => {},
  }}>{children}</PreferencesProvider></ThemeContext.Provider>;
}

/** Isolated synthetic renders: a finding must never appear without eligible evidence. */
export function checkYaldiArtwork(): number {
  let failures = 0;
  const check = (condition: boolean, label: string) => {
    if (!condition) failures++;
    console.log(`${condition ? "PASS" : "FAIL"}  B02 ${label}`);
  };
  for (const theme of ["light", "dark"] as const) {
    const context: ThemeContextValue = { theme, toggle: () => {}, chartTheme: { text: "", axis: "", split: "", tooltipBg: "", tooltipBorder: "", area: "" } };
    const render = (children: ReactNode, hideArtwork = false) => renderToStaticMarkup(
      <ThemeContext.Provider value={context}><PreferencesProvider storage={{
        getItem: () => JSON.stringify({ version: 1, labsEnabled: true, hideArtwork }), setItem: () => {},
      }}>{children}</PreferencesProvider></ThemeContext.Provider>,
    );
    const suffix = theme === "dark" ? "-dark" : "";
    for (const kind of ["loading", "analysing", "error", "empty", "insufficient", "resting"] as InvestigationStateKind[]) {
      const node = <InvestigationState kind={kind} detail="Synthetic scope and coverage explanation." onRetry={() => {}}><p>Evidence remains readable.</p></InvestigationState>;
      const html = render(node);
      const hidden = render(node, true);
      const art = kind === "loading" ? "investigating" : kind;
      check(html.includes(`/yaldi/state-${art}${suffix}.svg`) && html.includes('width="160" height="160"')
        && html.includes('alt="" aria-hidden="true"') && !html.includes("<svg"), `${theme} ${kind}: local img, intrinsic size and decorative semantics`);
      check([html, hidden].every(value => value.includes(`role="${kind === "error" ? "alert" : "status"}"`)
        && value.includes("Synthetic scope and coverage explanation.") && value.includes("Evidence remains readable.")
        && value.includes("Try again") === (kind === "error") && !value.includes("clue-found")) && !hidden.includes("<img"), `${theme} ${kind}: hiding art retains complete text, status and retry`);
    }
    const finding = <YaldiFindingArtwork evidenceSufficient={true} size={80} />;
    check(render(finding).includes(`/yaldi/state-clue-found${suffix}.svg`) && !render(finding, true).includes("<img")
      && !render(<YaldiFindingArtwork evidenceSufficient={false} />).includes("<img"), `${theme} finding requires sufficient evidence and obeys hideArtwork`);
    const brand = render(<MemoryRouter initialEntries={["/labs?range=all&sources=claude-code&selector=synthetic"]}><Wordmark /></MemoryRouter>);
    check(brand.includes(`/yaldi/mark-small${suffix}.svg`) && brand.includes('width="32" height="32"') && brand.includes('aria-label="Yald overview"')
      && brand.includes("Yald<span") && brand.includes("range=all&amp;sources=claude-code&amp;selector=synthetic") && !brand.includes("<svg"), `${theme} Yald. wordmark preserves navigation scope beside Yaldi`);
    check(!render(<><YaldiMark /><YaldiArtwork state="analysing" /></>, true).includes("<img"), `${theme} shared preference hides both mark and state artwork`);
  }
  return failures;
}
