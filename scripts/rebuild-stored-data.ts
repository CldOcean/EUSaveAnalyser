/**
 * Rebuild every stored viewer payload that is not in the browser format.
 *
 * `apps/site/src/build-viewer.ts` is the only producer of `saves/<id>/viewer/data.json`
 * and it publishes the browser payload `{version, data, panels}`. Saves rebuilt before
 * that rule existed still hold `render-timeline.ts`'s bare data plane, which
 * `viewer-store.js#loadStoredSave` refuses (`stored.data.tags` is its test) — the hosted
 * page then falls back to rebuilding in the browser (about 10 s), and the catalogue
 * loses the colonial flags it reads off the same file.
 *
 * This driver walks the catalogue, re-runs the builder for every save whose file is not
 * a payload yet, and verifies the result. It never deletes anything.
 *
 *   node scripts/rebuild-stored-data.ts [--root .dev-storage] [--all]
 *
 * `--all` (aliases `--refresh`, `--force`) rebuilds every catalogue save, payload or not.
 * The default only fixes a `viewer/data.json` that is *not* a payload yet, which means a
 * payload produced by older code — a stale data plane, e.g. the ones built before the
 * name tables existed — is never refreshed, and after any generator change the whole
 * catalogue silently stays stale. The default stays "repair what is broken" so a plain
 * run is still cheap; the launcher double-click uses `--all`.
 *
 * Chinese detail (per save: the state before, what happened, how long it took, and the
 * self-check against the pre-run catalogue) goes to `tmp/修复存档数据.txt`. The console
 * stays ASCII only: cmd opens a double-clicked batch at the system code page (936 here),
 * where UTF-8 Chinese turns into mojibake — and the launcher cannot even spell a Chinese
 * file name, so it opens the newest .txt in tmp instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const project = join(import.meta.dirname ?? '.', '..');
const args = process.argv.slice(2);
const valueOf = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
};

const root = valueOf('root', '.dev-storage');
const rebuildAll = args.includes('--all') || args.includes('--refresh') || args.includes('--force');
const storageRoot = isAbsolute(root) ? root : join(project, root);
const reportPath = join(project, 'tmp', '修复存档数据.txt');

interface SaveRecord {
  id: string;
  name?: string;
  viewerData?: boolean;
  info?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

/** What `viewer/data.json` holds right now, using the reader's own test. */
type Shape = 'payload' | 'offline' | 'missing' | 'unreadable';
function shapeOf(file: string): Shape {
  if (!existsSync(file)) return 'missing';
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { data?: { tags?: unknown } };
    return parsed?.data?.tags ? 'payload' : 'offline';
  } catch {
    return 'unreadable';
  }
}

const SHAPE_LABEL: Record<Shape, string> = {
  payload: '浏览器 payload（{version,data,panels}）',
  offline: '离线原始数据面（{w,h,scale,…}）',
  missing: '文件不存在',
  unreadable: '不是合法 JSON',
};

const indexPath = join(storageRoot, 'index.json');
if (!existsSync(indexPath)) {
  console.error(`catalogue not found: ${indexPath}`);
  process.exit(2);
}
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { saves?: SaveRecord[] };
const saves = Array.isArray(index.saves) ? index.saves : [];
// Snapshot of the catalogue as it was before the run: the self-check at the end compares
// against this, so a rebuild that quietly dropped `custom` or `viewerData` is caught here
// rather than by a person noticing an empty card.
const before = new Map(saves.map((save) => [save.id, JSON.parse(JSON.stringify(save)) as SaveRecord]));

const report: string[] = [];
const log = (line: string): void => {
  report.push(line);
};
const startedAll = Date.now();
const started = new Date();

let needsRebuild = 0;
for (const save of saves) {
  const dataPath = join(storageRoot, 'saves', save.id, 'viewer', 'data.json');
  if (rebuildAll || shapeOf(dataPath) !== 'payload') needsRebuild += 1;
}

log('修复存档数据 · 运行报告');
log(`生成时间：${started.toLocaleString('zh-CN', { hour12: false })}`);
log(`存档根目录：${storageRoot}`);
log(`存档总数：${saves.length}；开工前需要重建：${needsRebuild}`);
log(`模式：${rebuildAll ? '全量重建（--all）——每一份都重新生成，不看当前格式' : '只修复还不是 payload 的存档'}`);
log('');
log('规则：viewer/data.json 只有两种可能——浏览器 payload（{version,data,panels}）或');
log('重建前的离线原始数据面。宿主查看页（viewer-store.js 的 loadStoredSave）只认前者，');
log(
  rebuildAll
    ? '本次是全量重建（--all）：每一份都重新生成并逐份复验。全过程只重建、不删除。'
    : '所以本工具只处理"还不是 payload"的存档，重建后再逐份复验。全过程只重建、不删除。',
);
log('');

const outcomes: Array<{ id: string; ok: boolean; seconds: number; detail: string }> = [];
let done = 0;

for (const save of saves) {
  done += 1;
  const label = `[${done}/${saves.length}] ${save.id}  ${save.name ?? ''}`.trimEnd();
  const dataPath = join(storageRoot, 'saves', save.id, 'viewer', 'data.json');
  const savePath = join(storageRoot, 'saves', save.id, 'original.eu4');
  const shapeBefore = shapeOf(dataPath);

  if (!rebuildAll && shapeBefore === 'payload') {
    log(`${label}`);
    log('  处理前：已经是浏览器 payload');
    log('  结果：跳过（本工具不重建已符合格式的存档）');
    log('');
    outcomes.push({ id: save.id, ok: true, seconds: 0, detail: 'skipped (already payload)' });
    console.log(`[rebuild] ${save.id}  already payload - skipped`);
    continue;
  }

  log(`${label}`);
  log(`  处理前：${SHAPE_LABEL[shapeBefore]}${shapeBefore === 'payload' ? '（--all：仍然重建）' : ''}`);
  console.log(`[rebuild] ${save.id}  ${shapeBefore} -> rebuilding`);

  if (!existsSync(savePath)) {
    log(`  结果：失败——原始存档不存在：${savePath}`);
    log('');
    outcomes.push({ id: save.id, ok: false, seconds: 0, detail: `missing original.eu4` });
    console.log(`[rebuild] ${save.id}  FAILED - original.eu4 is missing`);
    continue;
  }

  const startedOne = Date.now();
  let failure = '';
  try {
    execFileSync(
      process.execPath,
      [join(project, 'apps', 'site', 'src', 'build-viewer.ts'), save.id, '--save', savePath, '--root', storageRoot],
      { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const tail = [detail.stdout ?? '', detail.stderr ?? '']
      .join('\n')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-6)
      .join('\n');
    failure = tail || detail.message || String(error);
  }
  const seconds = (Date.now() - startedOne) / 1000;
  const shapeAfter = shapeOf(dataPath);

  if (shapeAfter === 'payload') {
    // Report what the reader will actually find, not just that the command exited 0.
    const payload = JSON.parse(readFileSync(dataPath, 'utf8')) as {
      version?: number;
      data?: { tags?: unknown[] };
      panels?: { leaderHtml?: string };
    };
    const leaderRows = (payload.panels?.leaderHtml?.match(/<tr>/g) ?? []).length;
    log(
      `  结果：重建成功（${seconds.toFixed(1)} 秒）——version=${payload.version}，` +
        `data.tags=${payload.data?.tags?.length ?? 0} 个，panels.leaderHtml ${leaderRows} 行`,
    );
    console.log(`[rebuild] ${save.id}  ok in ${seconds.toFixed(1)} s (${payload.data?.tags?.length ?? 0} tags, ${leaderRows} leader rows)`);
    outcomes.push({ id: save.id, ok: true, seconds, detail: `${payload.data?.tags?.length ?? 0} tags` });
  } else {
    log(`  结果：失败——重建后仍是「${SHAPE_LABEL[shapeAfter]}」`);
    if (failure) log(`  构建命令输出（末尾几行）：\n${failure.split('\n').map((line) => `    ${line}`).join('\n')}`);
    console.log(`[rebuild] ${save.id}  FAILED - still ${shapeAfter} after the rebuild`);
    outcomes.push({ id: save.id, ok: false, seconds, detail: failure.split('\n')[0] ?? shapeAfter });
  }
  log('');
}

// ---- self-check against the pre-run catalogue -------------------------------
const after = JSON.parse(readFileSync(indexPath, 'utf8')) as { saves?: SaveRecord[] };
const afterById = new Map((after.saves ?? []).map((save) => [save.id, save]));
const missingIds = [...before.keys()].filter((id) => !afterById.has(id));
const customLost = [...before.values()]
  .filter((was) => was.custom !== undefined && JSON.stringify(afterById.get(was.id)?.custom) !== JSON.stringify(was.custom))
  .map((was) => was.id);
const viewerDataLost = [...before.values()]
  .filter((was) => Boolean(was.viewerData) && !afterById.get(was.id)?.viewerData)
  .map((was) => was.id);
/**
 * The keys `apps/site/src/build-viewer.ts` writes itself. Those are the ones a rebuild
 * owns, so those are the ones whose disappearance is a regression.
 *
 * This check used to look at *every* key that happened to be in `info`, which made a
 * perfectly good `--all` run report FAIL: two saves had been parsed inside the browser
 * at some point, so their `info` also carried `saveGame` / `parseMs` / `provinces` /
 * `countries` / `wars`, and the builder - which replaces `info` wholesale with its own
 * six-key parse - never writes those. They are listed separately below so nothing is
 * quietly hidden, but they are not this driver's contract.
 */
const BUILDER_INFO_KEYS = ['campaignDate', 'player', 'playerTag', 'version', 'dlcCount', 'mods'];
const infoLost: string[] = [];
const infoExtrasReplaced: string[] = [];
for (const was of before.values()) {
  const now = afterById.get(was.id)?.info;
  for (const key of Object.keys(was.info ?? {})) {
    if (now?.[key] !== undefined) continue;
    (BUILDER_INFO_KEYS.includes(key) ? infoLost : infoExtrasReplaced).push(`${was.id}.${key}`);
  }
}
const finalShapes = saves.map((save) => shapeOf(join(storageRoot, 'saves', save.id, 'viewer', 'data.json')));
const payloadCount = finalShapes.filter((shape) => shape === 'payload').length;
const failed = outcomes.filter((outcome) => !outcome.ok);

log('自检（与开工前的 index.json / meta.json 逐份比对）');
log(`  存档条数：开工前 ${before.size}，现在 ${after.saves?.length ?? 0}${missingIds.length ? `（丢了：${missingIds.join(', ')}）` : '（没有丢）'}`);
log(`  custom：${customLost.length ? `有 ${customLost.length} 份变了或被清空：${customLost.join(', ')}` : '一份都没有变'}`);
log(`  viewerData：${viewerDataLost.length ? `有 ${viewerDataLost.length} 份丢了：${viewerDataLost.join(', ')}` : '一份都没有丢'}`);
log(`  info 六键：${infoLost.length ? `有 ${infoLost.length} 个键丢了：${infoLost.join(', ')}` : '一个键都没有退化'}`);
log(
  `  info 附加键（浏览器解析写入、构建器不产出，重建时随 info 一起被替换）：` +
    `${infoExtrasReplaced.length ? `${infoExtrasReplaced.length} 个：${infoExtrasReplaced.join(', ')}` : '没有'}`,
);
log(`  最终格式：${payloadCount}/${saves.length} 份是浏览器 payload`);
log(`  耗时：${((Date.now() - startedAll) / 1000).toFixed(1)} 秒`);
log('');
log(failed.length === 0 && payloadCount === saves.length ? '结论：PASS——全部存档都是 payload 格式，没有丢数据。' : `结论：FAIL——${failed.length} 份没修好（${failed.map((f) => f.id).join(', ')}）。`);
log('');
log('注：控制台不显示中文（cmd 默认代码页会把 UTF-8 中文显示成乱码），所以中文详情只写进本文件。');

mkdirSync(join(project, 'tmp'), { recursive: true });
writeFileSync(reportPath, report.join('\r\n'), 'utf8');

const ok = failed.length === 0 && payloadCount === saves.length && missingIds.length === 0 && customLost.length === 0 && viewerDataLost.length === 0 && infoLost.length === 0;
console.log('');
console.log(`summary : payload ${payloadCount}/${saves.length}, rebuilt ${outcomes.filter((o) => o.ok && o.seconds > 0).length}, failed ${failed.length}`);
console.log(`catalogue: custom ${customLost.length} changed, viewerData ${viewerDataLost.length} lost, info keys ${infoLost.length} lost`);
console.log(`report  : tmp folder, Chinese file name (opened by the launcher)`);
console.log(ok ? 'RESULT  : PASS' : 'RESULT  : FAIL');
process.exit(ok ? 0 : 1);
