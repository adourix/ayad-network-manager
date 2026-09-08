export type VpnStatus = {
  vmessLink: string | null;
  enabled: boolean;
  connected: boolean;
  lastConnectedAt: string | null;
};

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.text();
  let data: unknown = null;

  if (body) {
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }
  }

  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return data as T;
};

export const vpnService = {
  getStatus: () => api<VpnStatus>("/api/vpn/status"),

  configure: (vmessLink: string) =>
    api<VpnStatus>("/api/vpn/config", {
      method: "POST",
      body: JSON.stringify({ vmessLink }),
    }),

  enable: () =>
    api<VpnStatus>("/api/vpn/enable", {
      method: "POST",
    }),

  disable: () =>
    api<VpnStatus>("/api/vpn/disable", {
      method: "POST",
    }),
};
