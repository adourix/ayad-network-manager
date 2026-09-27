import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, onUnauthorized } from "../services/api";

interface AuthContextValue {
  token: string | null;
  isAuthenticated: boolean;
  mustChangePassword: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(() => sessionStorage.getItem("nm_token"));
  const [mustChangePassword, setMustChangePassword] = useState(
    () => sessionStorage.getItem("nm_must_change_password") === "1",
  );

  useEffect(() => onUnauthorized(() => {
    sessionStorage.removeItem("nm_token");
    sessionStorage.removeItem("nm_must_change_password");
    setToken(null);
    setMustChangePassword(false);
  }), []);

  const value = useMemo<AuthContextValue>(() => ({
    token,
    isAuthenticated: Boolean(token),
    mustChangePassword,
    async login(username, password) {
      const response = await api.login(username, password);
      sessionStorage.setItem("nm_token", response.token);
      sessionStorage.setItem("nm_must_change_password", response.mustChangePassword ? "1" : "0");
      setToken(response.token);
      setMustChangePassword(response.mustChangePassword);
      return response.mustChangePassword;
    },
    async changePassword(currentPassword, newPassword) {
      await api.changePassword(currentPassword, newPassword);
      sessionStorage.setItem("nm_must_change_password", "0");
      setMustChangePassword(false);
    },
    async logout() {
      try { await api.logout(); } finally {
        sessionStorage.removeItem("nm_token");
        sessionStorage.removeItem("nm_must_change_password");
        setToken(null);
        setMustChangePassword(false);
      }
    },
  }), [token, mustChangePassword]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
