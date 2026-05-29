// ============================================================
// API client — thin fetch wrapper with admin token + error normalisation
// ============================================================
//
// The token lives in localStorage. When a call returns 401, we clear
// the token and surface an AuthError so the App can re-show the modal.

export const TOKEN_KEY = 'berryAdminToken';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class AuthError extends Error {
  constructor() {
    super('unauthorized — admin token missing or invalid');
    this.name = 'AuthError';
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  if (!token) throw new AuthError();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const resp = await fetch(path, { ...init, headers });
  if (resp.status === 401) {
    clearToken();
    throw new AuthError();
  }
  if (!resp.ok) {
    let payload: { error?: { code?: string; message?: string } } = {};
    try { payload = await resp.json() as typeof payload; } catch { /* non-JSON */ }
    throw new ApiError(
      resp.status,
      payload.error?.code ?? `http_${resp.status}`,
      payload.error?.message ?? `HTTP ${resp.status}`,
    );
  }
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('json')) return resp.json() as Promise<T>;
  return (await resp.text()) as unknown as T;
}

/** Fetch with token but return the raw Response for streaming use cases. */
export async function apiRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) throw new AuthError();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
