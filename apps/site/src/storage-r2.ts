/**
 * R2-backed storage for Cloudflare Pages Functions.
 *
 * The Workers runtime has no filesystem, so objects are the only place a save
 * can live. Request bodies are streamed straight into R2 (never buffered), which
 * matters because a save can be tens of megabytes.
 */
import type { Storage } from './api.ts';

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: Uint8Array | ReadableStream): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export function r2Storage(bucket: R2BucketLike): Storage {
  return {
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return undefined;
      return new Uint8Array(await object.arrayBuffer());
    },
    async put(key, body) {
      await bucket.put(key, body);
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      // R2 pages its listings, so keep walking until it says it is done.
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const object of page.objects) keys.push(object.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
  };
}
