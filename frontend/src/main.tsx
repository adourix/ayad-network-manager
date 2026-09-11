import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import SetupPage from "./SetupPage.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000 },
  },
});

const SETUP_STATUS_TIMEOUT_MS = 5_000;

function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const notify = () => {
      const nextPathname = window.location.pathname;
      flushSync(() => setPathname(nextPathname));
    };
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    window.history.pushState = function (...args) {
      originalPushState.apply(window.history, args);
      notify();
    };
    window.history.replaceState = function (...args) {
      originalReplaceState.apply(window.history, args);
      notify();
    };
    window.addEventListener("popstate", notify);

    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener("popstate", notify);
    };
  }, []);

  return pathname;
}

async function fetchSetupStatus(signal: AbortSignal): Promise<{ setupComplete: boolean }> {
  const response = await fetch("/api/setup/status", {
    headers: { Accept: "application/json" },
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error(`Setup status request failed (${response.status})`);
  return response.json() as Promise<{ setupComplete: boolean }>;
}

function Root() {
  const pathname = usePathname();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    // Never let a stalled setup-status request leave the entire application on
    // a permanent "Checking gateway setup" screen. If the status endpoint is
    // unavailable, setup mode is the safe fallback because it does not assume
    // that gateway configuration has completed.
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SETUP_STATUS_TIMEOUT_MS);
    let cancelled = false;

    fetchSetupStatus(controller.signal)
      .then((result) => {
        if (!cancelled) setSetupComplete(result.setupComplete === true);
      })
      .catch(() => {
        if (!cancelled) setSetupComplete(false);
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (setupComplete === null) return;

    if (!setupComplete && pathname !== "/setup") {
      window.location.replace("/setup");
    }
  }, [pathname, setupComplete]);

  if (setupComplete === null) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>Checking gateway setup…</div>;
  }

  // /setup is intentionally kept accessible after completion so the final
  // Apply/health-check result remains visible and navigation to login is explicit.
  if (pathname === "/setup") {
    return <SetupPage />;
  }

  if (!setupComplete) {
    return null;
  }

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
