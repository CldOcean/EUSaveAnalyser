/**
 * Cloudflare Pages Function -> /api/saves/:id
 *
 * The dynamic segment comes from the file name, so `[id].ts` maps to any id.
 *
 * GET     read one catalogue entry (the viewer's info panel prefills from it)
 * DELETE  remove the save and every object generated from it
 * PATCH   edit its catalogue entry (title, end date, mods, protagonists)
 */
import { deleteSave, getSave, updateSave, type ApiEnv } from '../../../src/api.ts';
import { r2Storage } from '../../../src/storage-r2.ts';

interface Env {
  SAVES_BUCKET: Parameters<typeof r2Storage>[0];
  UPLOAD_TOKEN?: string;
}

interface Context {
  request: Request;
  env: Env;
  params: { id: string | string[] };
}

const apiEnv = (env: Env): ApiEnv => ({ storage: r2Storage(env.SAVES_BUCKET), token: env.UPLOAD_TOKEN });

export const onRequestGet = async (context: Context): Promise<Response> =>
  getSave(String(context.params.id), context.request, apiEnv(context.env));

export const onRequestDelete = async (context: Context): Promise<Response> =>
  deleteSave(String(context.params.id), context.request, apiEnv(context.env));

export const onRequestPatch = async (context: Context): Promise<Response> =>
  updateSave(String(context.params.id), context.request, apiEnv(context.env));
