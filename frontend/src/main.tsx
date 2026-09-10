import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import SetupPage from "./SetupPage.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000 },
  },
});

function Root() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/setup/status", { headers: { Accept: "application/json" }, credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`Setup status request failed (${response.status})`);
        return response.json() as Promise<{ setupComplete: boolean }>;
      })
      .then((result) => {
        if (!cancelled) setSetupComplete(result.setupComplete === true);
      })
      .catch(() => {
        if (!cancelled) setSetupComplete(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (setupComplete === null) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>Checking gateway setup…</div>;
  }

  if (!setupComplete) return <SetupPage />;
  if (window.location.pathname === "/setup") return <SetupPage />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
