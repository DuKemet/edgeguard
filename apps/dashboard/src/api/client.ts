import type {
  AuthUser,
  ClientsResponse,
  DetectionSettings,
  EventsResponse,
  LoginResponse,
  OverviewResponse,
  RateLimitRule,
  RulePatchInput,
  RulesResponse,
  SettingsResponse,
  TrafficResponse,
} from "@edgeguard/shared";

const TOKEN_KEY = "edgeguard.token";
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api/admin";
const REQUEST_TIMEOUT_MS = 15_000;

export const AUTH_EXPIRED_EVENT = "edgeguard:auth-expired";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null = null,
    details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage may be unavailable in privacy modes; the in-memory session still works.
  }
}

export function clearToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage failures.
  }
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: unknown;
  };
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError(0, "TIMEOUT", "The gateway did not respond in time");
    }
    throw new ApiError(0, "NETWORK_ERROR", "Unable to reach the EdgeGuard gateway");
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    const code = envelope.error?.code ?? `HTTP_${response.status}`;
    const message = envelope.error?.message ?? "Request failed";
    if (response.status === 401 && options.auth !== false) {
      clearToken();
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    throw new ApiError(response.status, code, message, envelope.error?.requestId ?? null, envelope.error?.details ?? null);
  }

  return payload as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(name, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export const api = {
  login(username: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>("/auth/login", {
      method: "POST",
      body: { username, password },
      auth: false,
    });
  },
  me(): Promise<{ user: AuthUser }> {
    return request<{ user: AuthUser }>("/auth/me");
  },
  overview(): Promise<OverviewResponse> {
    return request<OverviewResponse>("/overview");
  },
  traffic(windowMinutes: number): Promise<TrafficResponse> {
    return request<TrafficResponse>(`/traffic${query({ windowMinutes })}`);
  },
  events(params: {
    page?: number;
    pageSize?: number;
    severity?: string;
    category?: string;
    q?: string;
  }): Promise<EventsResponse> {
    return request<EventsResponse>(`/events${query(params)}`);
  },
  clients(params: { page?: number; pageSize?: number; windowMinutes?: number }): Promise<ClientsResponse> {
    return request<ClientsResponse>(`/clients${query(params)}`);
  },
  rules(): Promise<RulesResponse> {
    return request<RulesResponse>("/rules");
  },
  createRule(rule: Omit<RateLimitRule, "updatedAt">): Promise<{ item: RateLimitRule }> {
    return request<{ item: RateLimitRule }>("/rules", { method: "POST", body: rule });
  },
  updateRule(id: string, patch: RulePatchInput): Promise<{ item: RateLimitRule }> {
    return request<{ item: RateLimitRule }>(`/rules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: patch,
    });
  },
  deleteRule(id: string): Promise<void> {
    return request<void>(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  settings(): Promise<SettingsResponse> {
    return request<SettingsResponse>("/settings");
  },
  updateSettings(detection: DetectionSettings): Promise<SettingsResponse> {
    return request<SettingsResponse>("/settings", { method: "PUT", body: { detection } });
  },
  unblock(clientId: string): Promise<{ unblocked: boolean; clientId: string; eventId: string }> {
    return request<{ unblocked: boolean; clientId: string; eventId: string }>(
      `/clients/${encodeURIComponent(clientId)}/unblock`,
      { method: "POST" },
    );
  },
};

export type { AuthUser, DetectionSettings, RateLimitRule };
