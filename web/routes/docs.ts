/**
 * @module web/routes/docs
 *
 * The user guide and the API documentation pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { helpPage } from '../../src/markdown.ts';
import { type Route, route } from '../routing.ts';
import type { Modules } from '../modules.ts';

/**
 * Docs routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function docsRoutes(modules: Modules): Route[] {
  const { HERE } = modules.context;
  const MANUAL = path.join(HERE, '..', 'docs', 'MANUAL.md');
  /**
   * The API-key routes as OpenAPI 3.1 (docs/openapi.json, kept in step with ROUTES by a test) and a Swagger UI page
   * for it at /api/docs, served from node_modules/swagger-ui-dist (no CDN, so the CSP stays 'self').
   */
  const DOCS_DIR = path.join(HERE, '..', 'docs');
  const SWAGGER_DIR = path.join(HERE, '..', 'node_modules', 'swagger-ui-dist');
  const SWAGGER_FILES: Record<string, string> = {
    'swagger-ui.css': 'text/css', 'swagger-ui-bundle.js': 'text/javascript', 'favicon-32x32.png': 'image/png', 'favicon-16x16.png': 'image/png',
  };
  const DOCS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DoorKing Gate Manager API</title><link rel="icon" type="image/png" href="/api/docs/favicon-32x32.png">
<link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/api/docs/swagger-ui-bundle.js"></script><script src="/api/docs/init.js"></script></body></html>`;
  const DOCS_INIT = `window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui', deepLinking: true, persistAuthorization: false,
  tryItOutEnabled: false, displayRequestDuration: true, defaultModelsExpandDepth: 0 });`;
  return [
    // The user guide (docs/MANUAL.md) as a page, read on each request so edits show at once. Public: it holds no gate data.
    route('GET', '/help', 'public', ({ reply }) => reply.type('text/html; charset=utf-8').send(helpPage(fs.readFileSync(MANUAL, 'utf8')))),

    // The API-key routes as OpenAPI (public: it holds no data) and the browsable docs page.
    route('GET', '/api/openapi.json', 'public', ({ reply }) => reply.header('Cache-Control', 'no-cache').type('application/json; charset=utf-8').sendFile('openapi.json', DOCS_DIR, { cacheControl: false })),
    route('GET', '/api/docs', 'public', ({ reply }) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(DOCS_PAGE)),
    route('GET', '/api/docs/:file', 'public', ({ params, reply }) => {
      if (params.file === 'init.js') return reply.header('Cache-Control', 'no-cache').type('text/javascript; charset=utf-8').send(DOCS_INIT);
      const type = SWAGGER_FILES[params.file];
      if (!type) return [404, { error: 'Not found' }];
      return reply.header('Cache-Control', 'no-cache').type(type).sendFile(params.file, SWAGGER_DIR, { cacheControl: false });
    }),
  ];
}
