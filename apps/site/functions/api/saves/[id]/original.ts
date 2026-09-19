/**
 * Cloudflare Pages Function -> GET /api/saves/:id/original
 *
 * Streams the stored save back so the browser can re-parse it (the catalogue's
 * "重新解析" button), without the user having to locate the file again.
 */
import { getOriginal, type ApiEnv } from '../../../../src/api.ts';
import { r2Storage } from '../../../../src/storage-r2.ts';

interface Env {
  SAVES_BUCKET: Parameters<typeof r2Storage>[0];
  UPLOAD_TOKEN?: string;
}

export const onRequestGet = async (context: {
  request: Request;
  env: Env;
  params: { id: string | string[] };
}): Promise<Response> => {
  const env: ApiEnv = { storage: r2Storage(context.env.SAVES_BUCKET), token: context.env.UPLOAD_TOKEN };
  return getOriginal(String(context.params.id), context.request, env);
};
