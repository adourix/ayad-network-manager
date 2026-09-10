import { StrictMode } from "react";
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

const Root = () => window.location.pathname === "/setup" ? <SetupPage /> : <App />;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
