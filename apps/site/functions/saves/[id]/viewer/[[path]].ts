/**
 * Cloudflare Pages Function -> /saves/:id/viewer/*
 *
 * Generated viewer files live in R2; this streams them back with a long cache
 * time. Without it the artifact would have to be committed to the repo, which is
 * exactly what R2 is here to avoid.
 *
 * `[[path]]` is a catch-all segment, so /saves/<id>/viewer/index.html and the
 * peak-*.png files next to it are all served by this one file.
 */
import type { Storage } from '../../../../src/api.ts';
import { r2Storage } from '../../../../src/storage-r2.ts';

interface Env {
  SAVES_BUCKET: Parameters<typeof r2Storage>[0];
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const extensionOf = (path: string): string => {
  const at = path.lastIndexOf('.');
  return at < 0 ? '' : path.slice(at).toLowerCase();
};

export const onRequestGet = async (context: {
  request: Request;
  env: Env;
  params: { id: string | string[]; path?: string | string[] };
}): Promise<Response> => {
  const id = String(context.params.id);
  const rest = context.params.path === undefined
    ? ''
    : Array.isArray(context.params.path)
      ? context.params.path.join('/')
      : String(context.params.path);
  const key = `saves/${id}/viewer/${rest}`;
  const storage: Storage = r2Storage(context.env.SAVES_BUCKET);
  const bytes = await storage.get(key);
  if (!bytes) return new Response('not found', { status: 404 });
  return new Response(bytes, {
    headers: {
      'content-type': TYPES[extensionOf(rest)] ?? 'application/octet-stream',
      // Generated viewers are immutable: rebuilding writes a new artifact only
      // when the save itself changes.
      'cache-control': 'public, max-age=86400',
    },
  });
};
