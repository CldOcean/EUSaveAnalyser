/**
 * Write the wallpaper list the hosted viewer reads.
 *
 * The generated page enumerates the folder at build time; the hosted one cannot
 * (Cloudflare has no directory listing), so the same list is published next to the
 * page as JSON. A missing file simply means "no wallpapers" to the viewer.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

/** Inside the site folder: that folder is the deploy output, so no copy step. */
const DIR = 'apps/site/public/背景图';
const OUT = 'apps/site/public/wallpapers.json';
/** URLs are site-relative, so they never carry the full path above. */
const URL_PREFIX = '背景图';

const files = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((file) => /\.(jpe?g|png|webp|avif)$/i.test(file))
      .sort()
  : [];

// Relative to the site root: the hosted viewer runs at /viewer.html and resolves
// these against the page, and the deployed site serves the folder at the root.
writeFileSync(OUT, JSON.stringify(files.map((file) => `${URL_PREFIX}/${file}`)), 'utf8');
console.log(`wrote ${OUT}: ${files.length} wallpapers`);
