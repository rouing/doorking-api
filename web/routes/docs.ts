// The user guide and the API documentation pages.
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { helpPage } from '../../src/markdown.ts';
import { type Route, route } from '../routing.ts';
import type { ContextModule } from '../context.ts';

export function docsRoutes(deps: ContextModule): Route[] {
  const { HERE, send } = deps;
  const MANUAL = path.join(HERE, '..', 'docs', 'MANUAL.md');
  // The API-key routes as OpenAPI 3.1 (docs/openapi.json, kept in step with ROUTES by a test) and a Swagger UI page
  // for it at /api/docs, served from node_modules/swagger-ui-dist (no CDN, so the CSP stays 'self').
  const OPENAPI = path.join(HERE, '..', 'docs', 'openapi.json');
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
  // Like send(), with images from data: URLs allowed (Swagger UI's icons).
  function sendDocs(res: ServerResponse, body: string | Buffer, type: string) {
    res.writeHead(200, {
      'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    });
    res.end(body);
  }
  return [
    // The user guide (docs/MANUAL.md) as a page, read on each request so edits show at once. Public: it holds no gate data.
    route('GET', '/help', 'public', ({ res }) => { send(res, 200, helpPage(fs.readFileSync(MANUAL, 'utf8')), 'text/html'); return undefined; }),

    // The API-key routes as OpenAPI (public: it holds no data) and the browsable docs page.
    route('GET', '/api/openapi.json', 'public', ({ res }) => { sendDocs(res, fs.readFileSync(OPENAPI, 'utf8'), 'application/json'); return undefined; }),
    route('GET', '/api/docs', 'public', ({ res }) => { sendDocs(res, DOCS_PAGE, 'text/html'); return undefined; }),
    route('GET', '/api/docs/:file', 'public', ({ params, res }) => {
      if (params.file === 'init.js') { sendDocs(res, DOCS_INIT, 'text/javascript'); return undefined; }
      const type = SWAGGER_FILES[params.file];
      if (!type) return [404, { error: 'Not found' }];
      sendDocs(res, fs.readFileSync(path.join(SWAGGER_DIR, params.file)), type);
      return undefined;
    }),
  ];
}
