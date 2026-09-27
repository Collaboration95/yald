import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { ThemeProvider } from "./lib/theme";
import { FiltersProvider } from "./lib/useFilters";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/Overview";
import { UsagePage } from "./pages/Usage";
import { CostPage } from "./pages/Cost";
import { PerformancePage } from "./pages/Performance";
import { ReliabilityPage } from "./pages/Reliability";
import { ModelsPage } from "./pages/Models";
import { QuotaPage } from "./pages/Quota";
import { ConversationDetailPage, ConversationsPage } from "./pages/Conversations";

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
          </FiltersProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
