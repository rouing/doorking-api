// The HTTP request handler: serves the built page and the REST API (routes from web/routes/), checking the host,
// origin, session or API key, role and step-up of every request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withContext } from '@logtape/logtape';
import * as dk from '../index.ts';
import type { Reply, Session } from './context.ts';
import { G, type Route } from './routing.ts';
import type { Modules } from './modules.ts';
import { logger } from '../src/logging.ts';

const DIST = path.join(import.meta.dirname, 'dist'); // the web page, built from web/ui by `npm run build`
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};
const NOT_BUILT = 'The web page is not built yet. Run `npm run build` in the project folder, then reload.';

// [file, content type] for the page or an asset URL, or null (for / when the page isn't built).
function staticFile(pathname: string): [string, string] | null {
  if (pathname === '/') {
    const built = path.join(DIST, 'index.html');
    return fs.existsSync(built) ? [built, 'text/html'] : null;
  }
  const m = /^\/assets\/([\w.-]+)$/.exec(pathname);
  const type = m && ASSET_TYPES[path.extname(m[1])];
  if (!m || !type) return null;
  const file = path.join(DIST, 'assets', m[1]);
  return fs.existsSync(file) ? [file, type] : null;
}

// Sensitive actions: a signed-in session needs a passkey confirmation (sign-in with a passkey, or POST
// /api/me/step-up) within security.stepUpMinutes, else 403 { stepUp: true, hasPasskey }. Accounts without a passkey
// can't do them until they add one. API keys aren't affected (they hold one gate and role already).
const STEP_UP = [
  `POST ${G}/send`, `POST ${G}/schedules`, `PUT ${G}/schedules/:id`, `POST ${G}/schedules/:id/run`,
  `PUT ${G}/login`, `POST ${G}/users`, `POST ${G}/users/:username/invite`, `POST ${G}/share`, `PUT ${G}/users/:username`,
  `DELETE ${G}/users/:username`, `POST ${G}/api-keys`, `DELETE ${G}/api-keys/:id`, `POST ${G}/delete-data`,
  'POST /api/me/sso/start', 'DELETE /api/me/sso/:provider/:subject',
];
// Marks the STEP_UP routes (throws when one is missing, so a renamed route can't silently lose its check).
export function markStepUp(routes: Route[]): void {
  for (const key of STEP_UP) {
    const found = routes.find((r) => `${r.method} ${r.pattern}` === key);
    if (!found) throw new Error(`STEP_UP: no route ${key}`);
    found.stepUp = true;
  }
}

// isStopping: the server is shutting down (new requests get 503).
export function createRequestHandler(deps: Modules, routes: Route[], isStopping: () => boolean) {
  const { ADMIN_ONLY, ALLOWED_HOSTS, ALLOWED_ORIGINS, asGate, currentSession, gateFor, readJson, send, stepUpRefusal, strongUntil, store } = deps;
  function match(method: string | undefined, pathname: string):
    { route: Route; params: Record<string, string> } | { route?: undefined; allow: string[] } {
    const hits = routes.map((r) => ({ r, m: r.re.exec(pathname) })).filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
    const hit = hits.find((x) => x.r.method === method);
    if (!hit) return { allow: hits.map((x) => x.r.method) };
    try {
      return { route: hit.r, params: Object.fromEntries(hit.r.keys.map((k, i) => [k, decodeURIComponent(hit.m[i + 1])])) };
    } catch { return { allow: [] }; } // a bad %-escape in the path (/api/gates/%E0): not found
  }

  const isReply = (x: Session | Reply): x is Reply => Array.isArray(x);
  // The session of a request with an API key (Authorization: Bearer <key>), or the refusal: a key reaches only its
  // own gate's data routes, never the web-only ones; no cookie session is used.
  async function apiKeySession(req: http.IncomingMessage, r: Route, params: Record<string, string>, pathname: string): Promise<Session | Reply> {
    const authorization = req.headers.authorization!;
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    const apiKey = bearer ? await dk.findApiKey(store, bearer[1]) : null;
    if (!apiKey) {
      logger('api').warn`${req.method} ${pathname}: refused, ${bearer ? 'invalid or expired API key' : 'not a Bearer key'}`;
      return [401, { error: bearer ? 'Invalid or expired API key' : 'Use the header Authorization: Bearer <API key>' }];
    }
    if (!r.scope.startsWith('gate') || r.webOnly || String(params.phone || '').replace(/\D/g, '') !== apiKey.phone) {
      return [403, { error: `This API key works only on /api/gates/${apiKey.phone}/… (gate login, users, API keys and deleting data are web-only)` }];
    }
    return { tokenHash: '', user: `api:${apiKey.name}`, gate: null, mustChangePassword: false, strongAt: null, signedInAt: 0, apiKey: { phone: apiKey.phone, role: apiKey.role } };
  }

  // Each request's log lines carry its requestId, and once known its user and gate (LogTape context).
  return (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => withContext({ requestId: crypto.randomUUID().slice(0, 8) }, async () => {
    try {
      if (isStopping()) return send(res, 503, { error: 'The server is restarting. Try again in a moment.' });
      if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const page = req.method === 'GET' ? staticFile(url.pathname) : null;
      if (page) return send(res, 200, fs.readFileSync(page[0]), page[1]);
      if (req.method === 'GET' && url.pathname === '/') return send(res, 503, NOT_BUILT, 'text/plain');
      const found = match(req.method, url.pathname);
      if (!found.route) {
        if (!found.allow.length) return send(res, 404, { error: 'Not found' });
        res.setHeader('Allow', found.allow.join(', '));
        return send(res, 405, { error: 'Method not allowed' });
      }
      const { route: r, params } = found;
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin.toLowerCase())) return send(res, 403, { error: 'Forbidden origin' });
      }
      const hasBody = req.method === 'POST' || req.method === 'PUT';
      if (hasBody && !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
      const keyed = req.headers.authorization !== undefined ? await apiKeySession(req, r, params, url.pathname) : null;
      if (keyed && isReply(keyed)) return send(res, ...keyed);
      const session = keyed ?? await currentSession(req);
      if (!session && r.scope !== 'public') return send(res, 401, { error: 'Not logged in' });
      if (session && session.mustChangePassword && r.scope !== 'public' && !(r.method === 'PUT' && url.pathname === '/api/me/password')) {
        return send(res, 403, { error: 'Choose a new password first', mustChangePassword: true });
      }
      return withContext({ ...(session && { user: session.user }), ...(params.phone && { gate: dk.phoneDigits(params.phone) }) }, async () => {
        let out: Reply | undefined | void;
        try {
          const body = hasBody ? await readJson(req) : {};
          const gate = !r.scope.startsWith('gate') ? null : session!.apiKey ? asGate((await dk.getGate(store, session!.apiKey.phone))!, session!.apiKey.role, session!.user)
            : await gateFor(session!, params.phone);
          out = gate && r.scope === 'gate-admin' && gate.role !== 'admin'
            ? [403, { error: ADMIN_ONLY }]
            : r.stepUp && !session!.apiKey && !strongUntil(session!) ? await stepUpRefusal(session!)
              : await r.handler({ session, gate, params, body, req, res });
        } catch (err) {
          const error = err as Error & { status?: number };
          out = [error.status || 400, { error: error.message }];
        }
        const failed = out && out[0] >= 400 ? out[1] as { error?: unknown } | null : null;
        if (out && failed && failed.error) logger('request')[out[0] >= 500 ? 'error' : 'warn']`${req.method} ${url.pathname}: ${out[0]} ${failed.error}`;
        return out && send(res, ...out);
      });
    } catch (err) {
      logger('request').error`${req.method} ${req.url}: 500 ${(err as Error).message}`;
      return send(res, 500, { error: (err as Error).message });
    }
  });
}
