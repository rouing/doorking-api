// Calls to the server's REST API (see web/server.ts). Errors carry the server's { error } message.
import { createContext, useContext } from 'react';

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let signedOut = () => {};
// Called when a request comes back 401 (the session ended), except the sign-in request itself, or 403 because the
// user must choose a new password first: either way the page reloads the session.
export function onSignedOut(fn: () => void) { signedOut = fn; }

let stepUp: (reply: Record<string, unknown>) => Promise<boolean> = async () => false;
let stepping: Promise<boolean> | null = null;
// Called when a sensitive action comes back 403 { stepUp: true } (a passkey confirmation is needed); resolves true
// once the user has confirmed, and the request is then sent once more. Requests waiting at the same time share it.
export function onStepUp(fn: (reply: Record<string, unknown>) => Promise<boolean>) { stepUp = fn; }

export function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> { return call<T>(method, url, body, false); }

async function call<T>(method: string, url: string, body: unknown, retried: boolean): Promise<T> {
  const res = await fetch(url, {
    method,
    // The server rejects any POST/PUT without a JSON content-type (415), so set it for every non-GET.
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if ((res.status === 401 && !(method === 'POST' && url === '/api/session')) || (res.status === 403 && json.mustChangePassword)) signedOut();
  if (res.status === 403 && json.stepUp && !retried) {
    stepping ||= stepUp(json).finally(() => { stepping = null; });
    if (await stepping) return call<T>(method, url, body, true);
  }
  if (!res.ok) throw new ApiError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`, res.status, json);
  return json as T;
}

export type GateApi = <T = unknown>(method: string, sub: string, body?: unknown) => Promise<T>;

// Requests for one gate: /api/gates/<phone><sub>.
export const gateUrl = (phone: string, sub: string) => `/api/gates/${encodeURIComponent(phone)}${sub}`;
export const gateApi = (phone: string): GateApi => (method, sub, body) => api(method, gateUrl(phone, sub), body);

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// True on a gate the signed-in user may only view (role readonly): edit controls are hidden or disabled. The server
// refuses changes anyway.
export const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);

// Called after a page saved to the working copy, so the gate's state (matches the gate / changes not sent) and Send to
// gate follow it (GateApp reloads its data).
export const WorkingCopySavedContext = createContext<() => Promise<void> | void>(() => {});

// Per-browser settings in localStorage. Never holds a password or master code.
export function lsGet<T>(key: string, def: T): T {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v) as T; } catch { return def; }
}
export function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}
