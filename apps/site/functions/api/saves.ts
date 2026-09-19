/**
 * Cloudflare Pages Function -> /api/saves
 *
 * Pages turns every file under `functions/` into a route by path, so this file
 * *is* the endpoint; nothing else needs configuring. The bindings it expects:
 *
 *   SAVES_BUCKET  R2 bucket binding (wrangler.toml)
 *   UPLOAD_TOKEN  secret, set in the Pages dashboard; without it the API is
 *                 read-only, which is the safe default for a public site
 *
 * GET    list the catalogue
 * POST   store one uploaded .eu4 (raw body, x-file-hash / x-file-name headers)
 */
import { listSaves, uploadSave, type ApiEnv } from '../../src/api.ts';
import { r2Storage } from '../../src/storage-r2.ts';

interface Env {
  SAVES_BUCKET: Parameters<typeof r2Storage>[0];
  UPLOAD_TOKEN?: string;
}

const apiEnv = (env: Env): ApiEnv => ({ storage: r2Storage(env.SAVES_BUCKET), token: env.UPLOAD_TOKEN });

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> =>
  listSaves(context.request, apiEnv(context.env));

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> =>
  uploadSave(context.request, apiEnv(context.env));
