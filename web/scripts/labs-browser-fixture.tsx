/** Native T3 preview fixture. Import on the synthetic Vite preview only; never in main.tsx. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DEFAULT_FILTERS, fetchJson, filtersToParams } from "../src/api";
import { PreferencesProvider, usePreferences, type PreferencesStorage } from "../src/lib/preferences";
import { InvestigationScope } from "../src/pages/labs/InvestigationScope";
import { InvestigationState } from "../src/pages/labs/InvestigationState";
import { LabsLayout } from "../src/pages/labs/LabsLayout";

export function mountLabsFixture({ blockedStorage = false }: { blockedStorage?: boolean } = {}) {
  if (document.getElementById("labs-browser-fixture")) throw new Error("Unmount the previous Labs fixture first");
  const element = document.createElement("section");
  element.id = "labs-browser-fixture";
  element.className = "mx-auto max-w-4xl space-y-4 p-6";
  element.setAttribute("aria-label", "Synthetic Labs fixtures");
  document.body.append(element);
  const root = createRoot(element);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  let saved: string | null = null;
  let queryCalls = 0;
  let mounts = 0;
  let unmounts = 0;
  let retries = 0;
  const storage: PreferencesStorage = {
    getItem: () => { if (blockedStorage) throw new Error("Synthetic blocked storage"); return saved; },
    setItem: (_key, value) => { if (blockedStorage) throw new Error("Synthetic blocked storage"); saved = value; },
  };
  function PollingInvestigation() {
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    const query = useQuery({
      queryKey: ["/api/labs/projects", "l01-synthetic-polling"],
      queryFn: () => { queryCalls++; return fetchJson("/api/labs/projects", filtersToParams(DEFAULT_FILTERS)); },
      staleTime: 0,
      refetchInterval: 200,
      refetchIntervalInBackground: true,
    });
    return <p>Polling fixture: {query.isSuccess ? "loaded" : "loading"}</p>;
  }
  function PreferenceProbe() {
    const { labsEnabled, hideArtwork, setPreference } = usePreferences();
    return <div>
      <output aria-label="Fixture preferences">{JSON.stringify({ labsEnabled, hideArtwork })}</output>
      <button type="button" className="ml-3 rounded border border-line p-2 text-ink" onClick={() => {
        setPreference("hideArtwork", true);
        setPreference("labsEnabled", false);
      }}>Set artwork preference and disable</button>
    </div>;
  }
  const cohort = { sources: ["ocx" as const], projects: ["/synthetic/{one,two}"], providers: ["synthetic-provider"], models: ["synthetic,model"],
    efforts: ["high"], statuses: ["ok" as const], routeKinds: ["native"], conversationId: "synthetic-session", search: "fixture" };
  root.render(<QueryClientProvider client={client}>
    <PreferencesProvider storage={storage}>
      <PreferenceProbe />
      <MemoryRouter initialEntries={["/labs"]}>
        <Routes><Route path="labs" element={<LabsLayout />}><Route index element={<PollingInvestigation />} /></Route></Routes>
      </MemoryRouter>
    </PreferencesProvider>
    <InvestigationState kind="loading" />
    <InvestigationState kind="error" detail="Synthetic fixture data is temporarily unavailable." onRetry={() => { retries++; }} />
    <InvestigationState kind="empty" />
    <InvestigationState kind="insufficient" detail="Only one request has measured input. At least two are needed for this comparison." />
    <InvestigationScope window={{ from: Date.parse("2026-09-01T00:00:00Z"), to: Date.parse("2026-09-02T00:00:00Z"), tz: "Asia/Singapore", label: "Fixed day" }}
      cohort={cohort} sample={{ eligibleRequests: 1, totalRequests: 4 }} unpricedRequests={2} unattributedRequests={1} />
  </QueryClientProvider>);
  return {
    snapshot: () => ({ saved, queryCalls, mounts, unmounts, retries, preferences: element.querySelector("output")?.textContent }),
    unmount: () => { root.unmount(); client.clear(); element.remove(); },
  };
}
