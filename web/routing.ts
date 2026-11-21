// Route table types and helpers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Body, Gate, Reply, Session } from './context.ts';

// Route table. scope: 'public' (no session), 'user' (signed in), 'gate' (signed in with any role on the gate in
// :phone, else 404), 'gate-admin' (admin role on it, else 403). Read-only users may view, pull and use the
// cameras. Handlers get { session, gate, params, body, req, res } and return [status, body], or answer themselves (file
// downloads) and return nothing. A user who must change their password reaches only the public routes and
// PUT /api/me/password until they do.
type Scope = 'public' | 'user' | 'gate' | 'gate-admin';
interface Ctx<S extends Scope> {
  session: S extends 'public' ? Session | null : Session;
  gate: S extends `gate${string}` ? Gate : null;
  params: Record<string, string>; body: Body; req: IncomingMessage; res: ServerResponse;
}
type Handler<S extends Scope> = (ctx: Ctx<S>) => Reply | undefined | void | Promise<Reply | undefined | void>;
// webOnly: refused for API keys (gate login, users, API keys, deleting the gate's data, leaving).
// stepUp: set from STEP_UP (sessions need a recent passkey confirmation).
export interface Route { method: string; pattern: string; re: RegExp; keys: string[]; scope: Scope; handler: Handler<Scope>; webOnly?: boolean; stepUp?: boolean }
export const webOnly = (r: Route): Route => ({ ...r, webOnly: true });

export function route<S extends Scope>(method: string, pattern: string, scope: S, handler: Handler<S>): Route {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; })}$`);
  return { method, pattern, re, keys, scope, handler: handler as unknown as Handler<Scope> };
}

export const G = '/api/gates/:phone';
