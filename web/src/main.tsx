import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import "./styles/relay.css";
import "./styles/delight.css";
import { ThemeProvider } from "./lib/theme";
import { RelayProvider } from "./lib/RelayProvider";
import { FiltersProvider } from "./lib/useFilters";
import { Layout } from "./components/Layout";
import { loadingQuip } from "./components/ui";
const OverviewPage = lazy(() => import("./pages/Overview").then(m => ({ default: m.OverviewPage })));
const UsagePage = lazy(() => import("./pages/Usage").then(m => ({ default: m.UsagePage })));
const CostPage = lazy(() => import("./pages/Cost").then(m => ({ default: m.CostPage })));
const PerformancePage = lazy(() => import("./pages/Performance").then(m => ({ default: m.PerformancePage })));
const ReliabilityPage = lazy(() => import("./pages/Reliability").then(m => ({ default: m.ReliabilityPage })));
const ModelsPage = lazy(() => import("./pages/Models").then(m => ({ default: m.ModelsPage })));
const QuotaPage = lazy(() => import("./pages/Quota").then(m => ({ default: m.QuotaPage })));
const ConversationsPage = lazy(() => import("./pages/Conversations").then(m => ({ default: m.ConversationsPage })));
const ConversationDetailPage = lazy(() => import("./pages/Conversations").then(m => ({ default: m.ConversationDetailPage })));

console.info(
  "%cyald.%c\nEvery request leaves a trace. Psst: try the Konami code, or just type “yald”.",
  "font: 800 28px Manrope, sans-serif; color: #d34d43",
  "font: 500 12px Manrope, sans-serif",
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <FiltersProvider>
            <RelayProvider>
            <Suspense fallback={<div className="p-6 text-sm text-muted">{loadingQuip()}</div>}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<OverviewPage />} />
                <Route path="usage" element={<UsagePage />} />
                <Route path="cost" element={<CostPage />} />
                <Route path="performance" element={<PerformancePage />} />
                <Route path="reliability" element={<ReliabilityPage />} />
                <Route path="models" element={<ModelsPage />} />
                <Route path="quota" element={<QuotaPage />} />
                <Route path="conversations" element={<ConversationsPage />} />
                <Route path="conversations/:id" element={<ConversationDetailPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
            </Suspense>
            </RelayProvider>
          </FiltersProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
