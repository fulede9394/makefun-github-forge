// app.ts — the HTTP server: reads each request body once, routes it to the git,
// REST, GraphQL or MCP surface, and answers JSON 404s for anything else. Every
// reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, sendJson } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 200 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isJsonBody(req: IncomingMessage, body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(store: Store, token: string): Server {
  let requestCounter = 0;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      res.setHeader('x-github-request-id', `req-${requestCounter}`);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? '127.0.0.1';

      try {
        // The boot probe takes no token.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        let body: Buffer;
        try {
          body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        } catch (err) {
          if (err instanceof Error && err.message === 'request body too large') {
            sendJson(res, 413, { message: 'Request body too large' });
            return;
          }
          throw err;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1];
          const repoName = gitMatch[2];
          const tail = gitMatch[3] === undefined || gitMatch[3] === '' ? [] : gitMatch[3].split('/').filter((segment) => segment !== '');
          const handled = await handleGit(req, res, store, owner, repoName, tail, url.searchParams, body);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const parsed = isJsonBody(req, body);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const segments = path.split('/').filter((segment) => segment !== '').slice(2);
          const handled = handleRest(method, segments, url.pathname + url.search, host, res, {
            store,
            query: url.searchParams,
            body: parsed.value,
          });
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const parsed = isJsonBody(req, body);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          handleGraphQL(parsed.value, store, res);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          handleMcp(req, res, store, token, body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { message });
        } else {
          res.destroy();
        }
      }
    })();
  });
}

/** True when the request carries the trial's bearer token (or when no token is configured). */
function authorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}
