/**
 * Local dev server for the catalogue site.
 *
 * It exists so the whole thing can be exercised without wrangler and without a
 * Cloudflare account: same handlers as the Pages Functions, but storage is a
 * folder on disk and the static files come from `public/`.
 *
 *   node apps/site/src/dev-server.ts [--port 8788] [--root .dev-storage]
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import {
  deleteSave,
  getOriginal,
  getSave,
  listSaves,
  putArtifact,
  updateSave,
  uploadSave,
  type ApiEnv,
} from './api.ts';
import { diskStorage } from './storage-disk.ts';

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? (process.argv[at + 1] as string) : fallback;
};

const PORT = Number(flag('port', '8788'));
const ROOT = flag('root', '.dev-storage');
/**
 * The site folder. It is the whole deploy output: the shared artwork
 * (assets/flags/...) and the wallpapers live *inside* it, so the dev server and
 * Cloudflare Pages serve exactly the same tree and neither needs a copy step.
 */
const PUBLIC = join(import.meta.dirname ?? '.', '..', 'public');

const env: ApiEnv = {
  storage: diskStorage(ROOT),
  token: process.env.UPLOAD_TOKEN,
  // Local dev is explicit: writes work without a token, production does not.
  allowAnonymousWrites: !process.env.UPLOAD_TOKEN,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Node's request stream -> what the fetch-style handlers expect. */
function toRequest(req: import('node:http').IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: string } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = req as unknown as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(url, init as RequestInit);
}

async function send(res: import('node:http').ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

function serveFile(base: string, relative: string): Response {
  // Keep the served path inside `base` - no directory traversal.
  const clean = normalize(decodeURIComponent(relative)).replace(/^([/\\])+/, '');
  let file = join(base, clean);
  if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return new Response('not found', { status: 404 });
  const body = readFileSync(file);
  const extension = extname(file).toLowerCase();
  const headers: Record<string, string> = { 'content-type': MIME[extension] ?? 'application/octet-stream' };
  /**
   * Never let the browser serve a cached copy of code or markup.
   *
   * Without this the page could keep running an old app.js after a change — which is
   * exactly what made a new upload path look like it had not been implemented. Images
   * and fonts are content, so they may still be cached.
   */
  if (CODE_EXTENSIONS.has(extension)) headers['cache-control'] = 'no-cache';
  return new Response(new Uint8Array(body), { headers });
}

const serveStatic = (pathname: string): Response => serveFile(PUBLIC, pathname);

/** Extensions that must never be served from the browser cache while developing. */
const CODE_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.mjs']);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    // Node keeps the path percent-encoded; decode once so prefixes that contain
    // non-ASCII names (the wallpaper folder) match. serveFile still refuses traversal.
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // A malformed escape just stays encoded and will 404.
    }
    try {
      if (pathname === '/api/saves') {
        const request = toRequest(req, url);
        await send(res, req.method === 'POST' ? await uploadSave(request, env) : await listSaves(request, env));
        return;
      }
      const match = /^\/api\/saves\/([^/]+)(\/artifact|\/original)?$/.exec(pathname);
      if (match) {
        const request = toRequest(req, url);
        const id = decodeURIComponent(match[1] as string);
        if (match[2] === '/artifact') {
          if (req.method === 'PUT') await send(res, await putArtifact(id, request, env, url));
          else await send(res, new Response('method not allowed', { status: 405 }));
        } else if (match[2] === '/original') {
          if (req.method === 'GET') await send(res, await getOriginal(id, request, env));
          else await send(res, new Response('method not allowed', { status: 405 }));
        } else if (req.method === 'GET') await send(res, await getSave(id, request, env));
        else if (req.method === 'DELETE') await send(res, await deleteSave(id, request, env));
        else if (req.method === 'PATCH') await send(res, await updateSave(id, request, env));
        else await send(res, new Response('method not allowed', { status: 405 }));
        return;
      }
      // /saves/<id>/viewer/index.html -> the same key in storage, which is what
      // the Pages Function does against R2 in production.
      if (pathname.startsWith('/saves/')) {
        const key = pathname.slice(1);
        const bytes = await env.storage.get(key);
        if (!bytes) {
          await send(res, new Response('not found', { status: 404 }));
          return;
        }
        await send(res, new Response(bytes, {
          headers: { 'content-type': MIME[extname(key).toLowerCase()] ?? 'application/octet-stream' },
        }));
        return;
      }
      await send(res, serveStatic(pathname));
    } catch (error) {
      await send(res, new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }));
    }
  })();
});

server.listen(PORT, () => {
  console.log(`catalogue dev server: http://127.0.0.1:${PORT}`);
  console.log(`  static:  ${PUBLIC}`);
  console.log(`  storage: ${ROOT} (disk adapter; Cloudflare uses R2)`);
  console.log(`  writes:  ${env.allowAnonymousWrites ? 'open (no UPLOAD_TOKEN set)' : 'token required'}`);
});

