/**
 * Cloudflare Pages Function -> PUT /api/saves/:id/artifact
 *
 * Where a locally generated viewer artifact is uploaded. The html sets the
 * record's `viewer` URL, which is what the catalogue's "打开查看页" button uses.
 */
import { putArtifact, type ApiEnv } from '../../../../src/api.ts';
import { r2Storage } from '../../../../src/storage-r2.ts';

interface Env {
  SAVES_BUCKET: Parameters<typeof r2Storage>[0];
  UPLOAD_TOKEN?: string;
}

export const onRequestPut = async (context: {
  request: Request;
  env: Env;
  params: { id: string | string[] };
}): Promise<Response> => {
  const env: ApiEnv = { storage: r2Storage(context.env.SAVES_BUCKET), token: context.env.UPLOAD_TOKEN };
  return putArtifact(String(context.params.id), context.request, env, new URL(context.request.url));
};
