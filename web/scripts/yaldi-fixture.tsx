/** Dev-only state fixture. Use Vite with OCX_API pointing at preview-fixture.ts. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Layout } from "../src/components/Layout";
import { YaldiFindingArtwork } from "../src/components/YaldiArtwork";
import { FiltersProvider } from "../src/lib/useFilters";
import { PreferencesProvider } from "../src/lib/preferences";
import { ThemeProvider } from "../src/lib/theme";
import { LabsLayout } from "../src/pages/labs/LabsLayout";
import { InvestigationState, type InvestigationStateKind } from "../src/pages/labs/InvestigationState";
import "../src/index.css";
import "../src/styles/relay.css";
import "../src/styles/delight.css";

const STATES = ["loading", "analysing", "empty", "error", "insufficient", "resting", "finding"] as const;
function Fixture() {
  const [state, setState] = useState<InvestigationStateKind | "finding">("loading");
  const [sufficient, setSufficient] = useState(true);
  const [retries, setRetries] = useState(0);
  return <div className="space-y-4">
    <p className="text-sm text-ink-soft">Synthetic sample data only. This fixture previews shared components; the three investigation findings still need parent integration.</p>
    <fieldset className="flex flex-wrap gap-2">
      <legend className="mb-2 text-sm font-semibold text-ink">Synthetic state</legend>
      {STATES.map(kind => <button key={kind} type="button" aria-pressed={state === kind} onClick={() => setState(kind)}
        className="rounded-lg border border-line px-3 py-2 text-sm text-ink">{kind}</button>)}
    </fieldset>
    {state === "finding" ? <section className="card flex items-start gap-4 p-5" aria-labelledby="synthetic-finding-title">
      <YaldiFindingArtwork evidenceSufficient={sufficient} />
      <div className="min-w-0 flex-1">
        <h2 id="synthetic-finding-title" className="text-sm font-semibold text-ink">{sufficient ? "Synthetic evidence-backed finding" : "Synthetic evidence is insufficient"}</h2>
        <p className="mt-1 text-sm text-ink-soft">{sufficient ? "Two eligible synthetic requests support this sample observation. Request IDs: synthetic-001, synthetic-002." : "This sample has no eligible request evidence. No finding artwork is shown."}</p>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={sufficient}
          onChange={event => setSufficient(event.target.checked)} />Sufficient evidence (synthetic)</label>
      </div>
    </section> : <InvestigationState kind={state} onRetry={() => setRetries(value => value + 1)}>
      <p className="mt-2 text-sm text-ink-soft">Synthetic fixture · retries: {retries}. State text and controls remain available with artwork hidden.</p>
    </InvestigationState>}
  </div>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ThemeProvider>
  <MemoryRouter initialEntries={["/labs/fixture?range=all"]}><FiltersProvider><PreferencesProvider>
    <Routes><Route element={<Layout />}><Route path="/labs" element={<LabsLayout />}>
      <Route path="fixture" element={<Fixture />} />
    </Route></Route></Routes>
  </PreferencesProvider></FiltersProvider></MemoryRouter>
</ThemeProvider></QueryClientProvider>);
