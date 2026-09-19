/**
 * Filesystem-backed storage for local development.
 *
 * Mirrors the R2 layout exactly (`saves/<id>/original.eu4`, `saves/<id>/meta.json`,
 * `index.json`) so switching between the dev server and Cloudflare is a config
 * change, not a code change.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Storage } from './api.ts';

export function diskStorage(root: string): Storage {
  const pathOf = (key: string): string => join(root, ...key.split('/'));
  return {
    async get(key) {
      try {
        return new Uint8Array(readFileSync(pathOf(key)));
      } catch {
        return undefined;
      }
    },
    async put(key, body) {
      const path = pathOf(key);
      mkdirSync(dirname(path), { recursive: true });
      if (body instanceof Uint8Array) {
        writeFileSync(path, body);
        return;
      }
      // A stream (an upload in flight): drain it and write once.
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      writeFileSync(path, Buffer.concat(chunks));
    },
    async delete(key) {
      rmSync(pathOf(key), { force: true, recursive: true });
    },
    async list(prefix) {
      const base = pathOf(prefix.replace(/\/$/, ''));
      const out: string[] = [];
      const walk = (dir: string, relative: string): void => {
        let entries: ReturnType<typeof readdirSync> = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const next = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(join(dir, entry.name), next);
          else out.push(`${prefix.replace(/\/$/, '')}/${next}`);
        }
      };
      walk(base, '');
      return out;
    },
  };
}
