import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, onUnauthorized } from "../services/api";

interface AuthContextValue {
  token: string | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(() => sessionStorage.getItem("nm_token"));

  useEffect(() => onUnauthorized(() => {
    sessionStorage.removeItem("nm_token");
    setToken(null);
  }), []);

  const value = useMemo<AuthContextValue>(() => ({
    token,
    isAuthenticated: Boolean(token),
    async login(username, password) {
      const response = await api.login(username, password);
      sessionStorage.setItem("nm_token", response.token);
      setToken(response.token);
    },
    async logout() {
      try { await api.logout(); } finally {
        sessionStorage.removeItem("nm_token");
        setToken(null);
      }
    },
  }), [token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
