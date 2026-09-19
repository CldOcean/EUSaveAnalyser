/**
 * Regression tests for the province sub-blocks `extractProvince()` used to drop.
 *
 * Root cause this pins: only `cores` and `institutions` were read, so every other
 * province sub-block (claims, buildings, building_builders, great_projects,
 * latent_trade_goods, country_improve_count) was silently discarded and the detail
 * panels had nothing to show. `devastation` and `active_trade_company` lived in
 * `extra` and are first-class fields now.
 *
 * The counts are the ones the read-only probes measured on the sample save
 * (`tmp/province-block-probe.ts`, `tmp/province-probe3.ts`), so a regression in the
 * extractor shows up as a number that moved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SaveDocument } from '../src/document.ts';

const SAVE = fileURLToPath(
  new URL('../../../存档示例/mp_俄罗斯1574_11_12.eu4', import.meta.url),
);

const doc = await SaveDocument.fromFile(SAVE);
const provinces = doc.provinces();

test('every province sub-block the panels need is extracted', () => {
  const stockholm = provinces.get(1)!;
  assert.deepEqual(stockholm.cores, ['SWE', 'RUS'], 'cores still work');
  assert.deepEqual(stockholm.buildings, ['marketplace', 'workshop', 'temple', 'shipyard']);
  assert.deepEqual(stockholm.buildingBuilders, {
    marketplace: 'SWE',
    workshop: 'RUS',
    temple: 'SWE',
    shipyard: 'DAN',
  });
  assert.deepEqual(stockholm.countryImprove, [{ tag: 'SWE', count: 5 }]);
  assert.equal(stockholm.claims.length, 0, 'province 1 has no claims');

  const ostra = provinces.get(2)!;
  assert.deepEqual(ostra.claims, ['RUS'], 'claims are a bare tag list');
  assert.deepEqual(ostra.buildings, []);

  const falun = provinces.get(8)!;
  assert.deepEqual(falun.greatProjects, ['falun_copper_mine'], 'great_projects is a bare list');
  const kronborg = provinces.get(12)!;
  assert.deepEqual(kronborg.greatProjects, ['kronborg']);

  const coal = provinces.get(62)!;
  assert.deepEqual(coal.latentTradeGoods, ['coal']);
  assert.ok(coal.devastation === undefined || typeof coal.devastation === 'number');
});

test('devastation and active_trade_company left `extra` for first-class fields', () => {
  let devastation = 0;
  let tradeCompany = 0;
  let stillInExtra = 0;
  for (const province of provinces.values()) {
    if ((province.devastation ?? 0) > 0) devastation += 1;
    if (province.activeTradeCompany) tradeCompany += 1;
    if ('devastation' in province.extra || 'active_trade_company' in province.extra) stillInExtra += 1;
  }
  assert.equal(devastation, 529, 'provinces with devastation above zero');
  assert.equal(tradeCompany, 155, 'provinces in a trade company');
  assert.equal(stillInExtra, 0, 'the two promoted scalars must not also stay in `extra`');
});

test('the province sub-block coverage matches the probes', () => {
  let buildings = 0;
  let claims = 0;
  let greatProjects = 0;
  let latent = 0;
  let improve = 0;
  const buildingKeys = new Set<string>();
  for (const province of provinces.values()) {
    if (province.buildings.length > 0) buildings += 1;
    for (const key of province.buildings) buildingKeys.add(key);
    if (province.claims.length > 0) claims += 1;
    if (province.greatProjects.length > 0) greatProjects += 1;
    if (province.latentTradeGoods.length > 0) latent += 1;
    if (province.countryImprove.length > 0) improve += 1;
    assert.ok(
      province.buildings.every((key) => province.buildingBuilders[key] !== undefined),
      `province ${province.id} has a building with no builder`,
    );
  }
  assert.equal(buildings, 1573);
  assert.equal(buildingKeys.size, 32);
  assert.equal(claims, 1814);
  assert.equal(greatProjects, 129);
  assert.equal(latent, 58);
  assert.equal(improve, 1837);
});
