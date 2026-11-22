// The HTTP request handler: serves the built page and the REST API (routes from web/routes/), checking the host,
// origin, session or API key, role and step-up of every request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withContext } from '@logtape/logtape';
import * as dk from '../index.ts';
import type { Gate, Reply, Session } from './context.ts';
import { G, type Route } from './routing.ts';
import type { Modules } from './modules.ts';
import { logger } from '../src/logging.ts';

const DIST = path.join(import.meta.dirname, 'dist'); // the web page, built from web/ui by `npm run build`
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.html': 'text/html',
};
const SERVER_FAULT = 'Something went wrong on the server. Try again; if it keeps happening, the server log has the details.';
const NOT_BUILT = 'The web page is not built yet. Run `npm run build` in the project folder, then reload.';

// [file, content type] for the page or an asset URL, or null (for / when the page isn't built).
export function staticFile(pathname: string): [string, string] | null {
  if (pathname === '/') {
    const built = path.join(DIST, 'index.html');
    return fs.existsSync(built) ? [built, 'text/html'] : null;
  }
  // /assets/<file>, or a file at the top of the build (the app's service worker, manifest and icons, from web/ui/public).
  const match = /^\/((?:assets\/)?[\w-][\w.-]*)$/.exec(pathname);
  const type = match && ASSET_TYPES[path.extname(match[1])];
  if (!match || !type) return null;
  const file = path.join(DIST, match[1]);
  return fs.existsSync(file) ? [file, type] : null;
}

// Sensitive actions: a signed-in session needs a passkey confirmation (sign-in with a passkey, or POST
// /api/me/step-up) within security.stepUpMinutes, else 403 { stepUp: true, hasPasskey }. Accounts without a passkey
// can't do them until they add one. API keys aren't affected (they hold one gate and role already).
const STEP_UP = [
  `POST ${G}/send`, `POST ${G}/schedules`, `PUT ${G}/schedules/:id`, `POST ${G}/schedules/:id/run`,
  `PUT ${G}/login`, `POST ${G}/users`, `POST ${G}/users/:username/invite`, `POST ${G}/share`, `PUT ${G}/users/:username`,
  `DELETE ${G}/users/:username`, `POST ${G}/api-keys`, `DELETE ${G}/api-keys/:id`, `POST ${G}/delete-data`,
  'POST /api/me/sso/start', 'DELETE /api/me/sso/:provider/:subject', 'POST /api/me/passkeys/approval',
];
// Marks the STEP_UP routes (throws when one is missing, so a renamed route can't silently lose its check).
export function markStepUp(routes: Route[]): void {
  for (const key of STEP_UP) {
    const found = routes.find((route) => `${route.method} ${route.pattern}` === key);
    if (!found) throw new Error(`STEP_UP: no route ${key}`);
    found.stepUp = true;
  }
}

// isStopping: the server is shutting down (new requests get 503).
export function createRequestHandler(modules: Modules, routes: Route[], isStopping: () => boolean) {
  const { ADMIN_ONLY, asGate, gateFor, NO_GATE, readJson, send, store } = modules.context;
  const { ALLOWED_HOSTS, ALLOWED_ORIGINS, currentSession, stepUpRefusal, strongUntil } = modules.auth;
  function match(method: string | undefined, pathname: string):
    { route: Route; params: Record<string, string> } | { route?: undefined; allow: string[] } {
    const hits = routes.map((route) => ({ r: route, m: route.re.exec(pathname) })).filter((hit): hit is { r: Route; m: RegExpExecArray } => hit.m !== null);
    const hit = hits.find((candidate) => candidate.r.method === method);
    if (!hit) return { allow: hits.map((candidate) => candidate.r.method) };
    try {
      return { route: hit.r, params: Object.fromEntries(hit.r.keys.map((key, i) => [key, decodeURIComponent(hit.m[i + 1])])) };
    } catch { return { allow: [] }; } // a bad %-escape in the path (/api/gates/%E0): not found
  }

  const isReply = (result: Session | Reply): result is Reply => Array.isArray(result);
  // The session of a request with an API key (Authorization: Bearer <key>), or the refusal: a key reaches only its
  // own gate's data routes, never the web-only ones; no cookie session is used.
  async function apiKeySession(req: http.IncomingMessage, route: Route, params: Record<string, string>, pathname: string): Promise<Session | Reply> {
    const authorization = req.headers.authorization!;
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    const apiKey = bearer ? await dk.findApiKey(store, bearer[1]) : null;
    if (!apiKey) {
      logger('api').warn`${req.method} ${pathname}: refused, ${bearer ? 'invalid or expired API key' : 'not a Bearer key'}`;
      return [401, { error: bearer ? 'Invalid or expired API key' : 'Use the header Authorization: Bearer <API key>' }];
    }
    if (!route.scope.startsWith('gate') || route.webOnly || String(params.phone || '').replace(/\D/g, '') !== apiKey.phone) {
      return [403, { error: `This API key works only on /api/gates/${apiKey.phone}/… (gate login, users, API keys and deleting data are web-only)` }];
    }
    return { tokenHash: '', user: `api:${apiKey.name}`, gate: null, mustChangePassword: false, strongAt: null, signedInAt: 0, apiKey: { phone: apiKey.phone, role: apiKey.role } };
  }

  // Answers a request for the built page and its files: true when it was one.
  function servePage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    if (req.method !== 'GET') return false;
    const page = staticFile(url.pathname);
    if (page) send(res, 200, fs.readFileSync(page[0]), page[1]);
    else if (url.pathname === '/') send(res, 503, NOT_BUILT, 'text/plain');
    return Boolean(page) || url.pathname === '/';
  }

  // Refuses a change from another site's page (origin) and a body that isn't JSON.
  function requestRefusal(req: http.IncomingMessage, hasBody: boolean): Reply | null {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !ALLOWED_ORIGINS.has(origin.toLowerCase())) return [403, { error: 'Forbidden origin' }];
    if (hasBody && !/^application\/json/.test(req.headers['content-type'] || '')) return [415, { error: 'JSON required' }];
    return null;
  }

  // The request's session (an API key's, else the cookie's; null on public routes), or why it is refused.
  async function sessionFor(req: http.IncomingMessage, route: Route, params: Record<string, string>, pathname: string): Promise<Session | null | Reply> {
    const keyed = req.headers.authorization !== undefined ? await apiKeySession(req, route, params, pathname) : null;
    if (keyed && isReply(keyed)) return keyed;
    const session = keyed ?? await currentSession(req);
    if (!session && route.scope !== 'public') return [401, { error: 'Not logged in' }];
    if (session && session.mustChangePassword && route.scope !== 'public' && !(route.method === 'PUT' && pathname === '/api/me/password')) {
      return [403, { error: 'Choose a new password first', mustChangePassword: true }];
    }
    return session;
  }

  // Runs the route for the session: its gate (gate routes), the admin and step-up checks, then the handler.
  async function runRoute(route: Route, session: Session | null, params: Record<string, string>, req: http.IncomingMessage,
    res: http.ServerResponse, hasBody: boolean): Promise<Reply | undefined | void> {
    const body = hasBody ? await readJson(req) : {};
    const gate = route.scope.startsWith('gate') ? await routeGate(session!, params.phone) : null;
    if (gate && route.scope === 'gate-admin' && gate.role !== 'admin') return [403, { error: ADMIN_ONLY }];
    if (route.stepUp && !session!.apiKey && !strongUntil(session!)) return stepUpRefusal(session!);
    return route.handler({ session, gate, params, body, req, res });
  }

  // A gate route's gate: an API key's own gate (404 when it was deleted meanwhile), else the one in the URL.
  async function routeGate(session: Session, phone: string): Promise<Gate> {
    if (!session.apiKey) return gateFor(session, phone);
    const rec = await dk.getGate(store, session.apiKey.phone);
    if (!rec) throw dk.httpError(NO_GATE, 404);
    return asGate(rec, session.apiKey.role, session.user);
  }

  // The reply for an error a route threw: errors meant for the user carry their status (httpError); anything else is
  // a fault here: 500, with the details only in the server log.
  function errorReply(err: unknown, req: http.IncomingMessage, pathname: string): Reply {
    const error = err as Error & { status?: unknown };
    if (typeof error.status === 'number') return [error.status, { error: error.message }];
    logger('request').error`${req.method} ${pathname}: ${error && error.stack ? error.stack : String(err)}`;
    return [500, { error: SERVER_FAULT }];
  }

  // Writes a refused or failed request to the server log (a fault was logged with its details already).
  function logFailure(out: Reply, req: http.IncomingMessage, pathname: string): void {
    const failed = out[0] >= 400 ? out[1] as { error?: unknown } | null : null;
    if (failed && failed.error && failed.error !== SERVER_FAULT) {
      logger('request')[out[0] >= 500 ? 'error' : 'warn']`${req.method} ${pathname}: ${out[0]} ${failed.error}`;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (isStopping()) return send(res, 503, { error: 'The server is restarting. Try again in a moment.' });
    if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'Forbidden host' });
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (servePage(req, res, url)) return;
    const found = match(req.method, url.pathname);
    if (!found.route) {
      if (!found.allow.length) return send(res, 404, { error: 'Not found' });
      res.setHeader('Allow', found.allow.join(', '));
      return send(res, 405, { error: 'Method not allowed' });
    }
    const { route, params } = found;
    const hasBody = req.method === 'POST' || req.method === 'PUT';
    const refused = requestRefusal(req, hasBody);
    if (refused) return send(res, ...refused);
    const session = await sessionFor(req, route, params, url.pathname);
    if (session && isReply(session)) return send(res, ...session);
    return withContext({ ...(session && { user: session.user }), ...(params.phone && { gate: dk.phoneDigits(params.phone) }) }, async () => {
      let out: Reply | undefined | void;
      try { out = await runRoute(route, session, params, req, res, hasBody); } catch (err) { out = errorReply(err, req, url.pathname); }
      if (!out) return;
      logFailure(out, req, url.pathname);
      send(res, ...out);
    });
  }

  // Each request's log lines carry its requestId, and once known its user and gate (LogTape context).
  return (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => withContext({ requestId: crypto.randomUUID().slice(0, 8) }, async () => {
    try {
      await handle(req, res);
    } catch (err) {
      logger('request').error`${req.method} ${req.url}: 500 ${(err as Error).stack || String(err)}`;
      send(res, 500, { error: SERVER_FAULT });
    }
  });
}
