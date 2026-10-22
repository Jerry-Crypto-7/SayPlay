#!/usr/bin/env node
/**
 * P57 T8r bod 4 (rozhodnutí 22. 10.): vegetace z knihovny vychází z generátoru špatně – vezme se
 * z CC0 balíků, které už leží na disku, a vymění pod stejným id, když vyhraje slepý souboj.
 *
 *   node scripts/p57/cc0-veg.mjs [--out D:/caches/p57/cc0-veg] [--only id,id]   najde, napasuje, oskóruje, odsoudí; repo nezmění
 *   node scripts/p57/cc0-veg.mjs --apply                                         navíc vymění vítěze a zapíše `cc0Veg` do top50.json
 *
 * Cíle: vegetace z `heroTargets` (top 50), která v `top50.json` ještě není `replaced` se skóre ≥ 8, a vegetace
 * z `kit-missing.json`, jejíž id katalog má se skóre pod 6. Kandidáti podle názvu souboru
 * (`queryFor` + `matchFiles`) ze všech balíků v cache; každý soubor projde `cc0Refusal` (CC0-1.0
 * v `sources.json` i v přibaleném textu licence). Pak `normalizeModel` se stylem katalogu (paleta
 * jako ostatní CC0 modely), `fit` do starého boxu a zkouška výměny (`profileLimits` hero +
 * `replaceRefusal`, totéž co `replaceModels`). Kdo projde, dostane slepé skóre 1–10 od Opuse na
 * mřížkách 3×3; nejlepší se skóre ≥ 6 jde na souboj se současným modelem (`runDuel`, Codex jen
 * daleko od sdíleného denního stropu). Vše v `<out>/state.json`: co je souzené, se znovu neptá;
 * souboj patří k hashi starého LOD0 – když starý model mezitím vymění jiný běh, odsoudí se znovu.
 * Bez `--apply` nepíše `src/assets`, `public/`, `disclosure.json` ani `DISCLOSURE.md`.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelTokensOf } from '../assets/cc0/tokens.mjs';
import { DUEL_FLOOR, duelWins, runDuel } from './duel.mjs';
import { CODEX_DAILY_CAP, COUNTER, mergeAttempts, sheetEntries, takeCodexCall } from './judge-library.mjs';
import { dimsOf, fit, shuffleKey } from './regen.mjs';
import { HERO_PASS, heroSummary, heroTargets } from './top50.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPORT = path.join(ROOT, 'evals/play/p57/top50.json');
/** Codex jen daleko od denního stropu: strop je sdílený a dávky top 50 ho potřebují víc. */
export const CODEX_RESERVE = 15;

/** Slova, podle kterých je jméno rostlina. */
const VEG_WORDS = new Set([
  'tree', 'trees', 'bush', 'bushes', 'shrub', 'hedge', 'grass', 'tuft', 'flower', 'flowers', 'wildflower', 'wildflowers', 'plant', 'sapling',
  'palm', 'cactus', 'fern', 'birch', 'pine', 'willow', 'poplar', 'olive', 'oak', 'maple', 'cherry', 'bamboo', 'reed', 'clover', 'ivy', 'vine', 'moss',
  'sunflower', 'buttercup', 'poppy', 'tulip', 'rose', 'daisy', 'lily', 'lavender', 'dandelion', 'thorn',
]);
/** Slova, se kterými jméno rostlinu jen nese nebo zdobí: truhlík, stánek, vozík, kámen s mechem, zeď s břečťanem. */
const NOT_VEG = new Set(['box', 'planter', 'pot', 'stall', 'cart', 'stand', 'rock', 'boulder', 'stone', 'wall', 'table', 'bench', 'banner', 'arch', 'house', 'hut']);

const wordsOf = (noun) => noun.toLowerCase().split(/[\s-]+/).filter(Boolean);

/** Je jméno vegetace (strom, keř, tráva, květina…), ne věc s rostlinou? */
export const isVegetation = (noun) => wordsOf(noun).some((word) => VEG_WORDS.has(word)) && !wordsOf(noun).some((word) => NOT_VEG.has(word));

/** Druhy: druh ze jména musí být i v názvu souboru (bříza je bříza, ne jakýkoli strom). Druh bez dotazu v `QUERIES` CC0 balíky nemají. */
const SPECIES = new Set(['birch', 'palm', 'pine', 'willow', 'poplar', 'olive', 'apple', 'oak', 'maple', 'cherry', 'cactus', 'bamboo', 'fern', 'sunflower',
  'buttercup', 'poppy', 'tulip', 'rose', 'daisy', 'lily', 'lavender', 'dandelion', 'thorn', 'ivy', 'vine', 'moss', 'clover', 'reed', 'wheat', 'corn']);
const ALIASES = { tuft: 'grass', wildflower: 'flower', wildflowers: 'flower', flowers: 'flower', trees: 'tree', bushes: 'bush' };

/**
 * Dotazy na slova názvu souboru (`modelTokensOf`): z každé skupiny `all` aspoň jedno slovo, žádné z `none`.
 * Pryskyřník a vlčí mák jsou žlutá a červená luční květina (`flower_yellowA`, `flower_redA`).
 */
export const QUERIES = {
  tree: { all: [['tree']], none: ['birch', 'palm', 'pine', 'willow', 'apple', 'fruit', 'sakura', 'cherry', 'cactus'] },
  bush: { all: [['bush']] },
  shrub: { all: [['bush', 'shrub']] },
  hedge: { all: [['hedge']], none: ['gate', 'corner', 'curved'] },
  grass: { all: [['grass']] },
  flower: { all: [['flower', 'flowers']], none: ['bush', 'cactus', 'tree', 'horn'] },
  plant: { all: [['plant']] },
  birch: { all: [['birch']] },
  palm: { all: [['palm']] },
  pine: { all: [['pine']] },
  willow: { all: [['willow']] },
  maple: { all: [['maple']] },
  oak: { all: [['oak']] },
  apple: { all: [['tree'], ['apple', 'fruit']] },
  cactus: { all: [['cactus']] },
  bamboo: { all: [['bamboo']] },
  buttercup: { all: [['flower', 'flowers'], ['yellow']], none: ['bush', 'cactus', 'tree'] },
  poppy: { all: [['flower', 'flowers'], ['red']], none: ['bush', 'cactus', 'tree'] },
};
/** Varianty, které ve hře tím jménem nejsou: sníh, podzim, uschlé, pařez, kmen, kámen s trávou, dlaždice a bloky terénu, květináč. */
const OFF = ['snow', 'autumn', 'fall', 'dead', 'stump', 'log', 'trunk', 'decorated', 'rock', 'stone', 'pot', 'planter', 'tile', 'block', 'cube', 'ground', 'platform', 'patch'];
/** Balíky, jejichž „stromy“ a „keře“ jsou mimozemské, strašidelné nebo postavy. */
const ALIEN_PACKS = new Set(['quaternius-ultimate-space-kit', 'kenney-space-kit', 'kenney-space-station-kit', 'kaykit-space-base-bits', 'quaternius-cute-monsters', 'quaternius-cute-fish', 'kaykit-halloween-bits']);

/** Dotaz pro jméno: druh má přednost (`palm tree` → palm), jinak poslední známé slovo (`street tree` → tree); `null` = CC0 nemá. */
export function queryFor(noun) {
  const words = wordsOf(noun).map((word) => ALIASES[word] ?? word);
  const species = words.find((word) => SPECIES.has(word));
  if (species) return QUERIES[species] ? { key: species, ...QUERIES[species] } : null;
  const kind = words.findLast((word) => QUERIES[word]);
  return kind ? { key: kind, ...QUERIES[kind] } : null;
}

/** Soubory `{ pack, file }` podle dotazu, bez `skip` (`pack/file`) a bez dvojího formátu téhož modelu (GLB má přednost). */
export function matchFiles(query, models, skip = new Set()) {
  if (!query) return [];
  const seen = new Set();
  const sorted = [...models].sort((a, b) => Number(/\.gltf$/i.test(a.file)) - Number(/\.gltf$/i.test(b.file)));
  return sorted.filter(({ pack, file }) => {
    if (ALIEN_PACKS.has(pack) || skip.has(`${pack}/${file}`)) return false;
    const tokens = modelTokensOf(file);
    if (!query.all.every((group) => group.some((word) => tokens.includes(word)))) return false;
    if ([...OFF, ...(query.none ?? [])].some((word) => tokens.includes(word))) return false;
    const stem = `${pack}/${path.posix.basename(file).replace(/\.(glb|gltf)$/i, '')}`;
    if (seen.has(stem)) return false;
    seen.add(stem);
    return true;
  }).sort((a, b) => `${a.pack}/${a.file}`.localeCompare(`${b.pack}/${b.file}`));
}

/**
 * Cíle: vegetace z top 50 bez `replaced` (ani z tohoto skriptu) a vegetace z `kit-missing.json`, kterou katalog má
 * pod 6. `outside` = vegetace z kitu, kterou katalog nemá – sem nepatří, jen se vypíše.
 */
export function vegTargets({ judge, usage, catalog, report = {}, kit = { missing: [] } }) {
  const byId = new Map(catalog.assets.map((asset) => [asset.assetId, asset]));
  // Výměna z generátoru pod 8 id neuzavře: CC0 kandidát se utká s ní.
  const done = (id) => (report.models?.[id]?.result === 'replaced' && report.models[id].newScore >= HERO_PASS) || report.cc0Veg?.models?.[id]?.result === 'replaced';
  const targets = heroTargets(judge, usage, catalog).filter((id) => isVegetation(byId.get(id).tags[0]) && !done(id))
    .map((id) => ({ id, noun: byId.get(id).tags[0], from: 'top50' }));
  const outside = [];
  for (const { id, noun } of kit.missing.filter((entry) => isVegetation(entry.noun))) {
    if (!byId.has(id)) {
      if (!outside.some((entry) => entry.id === id)) outside.push({ id, noun });
    } else if (!targets.some((target) => target.id === id) && !done(id) && !(judge.models[id]?.score >= 6)) targets.push({ id, noun, from: 'kit' });
  }
  return { targets, outside };
}

/** Nejlepší kandidát se skóre ≥ `DUEL_FLOOR`, který prošel zkouškou výměny; shoda → dřívější. */
export const bestCandidate = (candidates) => candidates.filter((candidate) => candidate.glb && !candidate.refused && typeof candidate.score === 'number' && candidate.score >= DUEL_FLOOR)
  .reduce((best, candidate) => (best && best.score >= candidate.score ? best : candidate), null);

/**
 * Výsledek id: `replace` (vyhrál souboj, výměna čeká na `--apply`), `kept-old` (prohrál), `below-6`, `no-fit`
 * (nic se nevešlo do starého boxu nebo neprošlo zkouškou výměny), `no-cc0-match`, `unjudged` (souboj chybí).
 */
export function vegResult(item) {
  if (item.candidates.length === 0) return 'no-cc0-match';
  if (!item.candidates.some((candidate) => candidate.glb && !candidate.refused)) return 'no-fit';
  const best = bestCandidate(item.candidates);
  if (!best) return 'below-6';
  if (item.duel?.candidate !== best.key || item.duel.oldHash !== item.oldHash) return 'unjudged';
  return duelWins(best.score, item.duel.votes.map((vote) => vote.vote)) ? 'replace' : 'kept-old';
}

/** Záznam `cc0Veg` v top50.json pro jedno id. */
export function vegSummary(item) {
  const best = bestCandidate(item.candidates) ?? item.candidates.filter((candidate) => typeof candidate.score === 'number').sort((a, b) => b.score - a.score)[0];
  const refused = item.candidates.filter((candidate) => candidate.fit && candidate.fit !== 'ok').length + item.candidates.filter((candidate) => candidate.refused).length;
  return {
    noun: item.noun, from: item.from, query: item.query, candidates: item.candidates.length, rejectedFit: refused,
    pack: best?.pack ?? null, file: best?.file ?? null, score: best?.score ?? null, judgeName: best?.name ?? null,
    duel: item.duel && item.duel.candidate === best?.key ? item.duel.votes.map(({ judge, vote, reason }) => ({ judge, vote, reason })) : null,
    result: item.applied ?? vegResult(item),
    ...(item.refusedAt ? { reason: item.refusedAt } : {}),
  };
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** GLB a glTF stažených balíků jako `cacheModels` v `select.mjs` – ten tahá TS kód hry, který holý Node nenačte. */
export function packModels(fetched) {
  const models = [];
  for (const record of fetched.packs.filter((entry) => !entry.skipped)) {
    const dir = path.join(fetched.cache, record.pack);
    const walk = (at) => {
      for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(glb|gltf)$/i.test(entry.name)) models.push({ pack: record.pack, file: path.relative(dir, full).replaceAll('\\', '/') });
      }
    };
    if (existsSync(dir)) walk(dir);
  }
  return models;
}

async function main() {
  if (!process.features.typescript) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  const { HERO_MAX_TRIANGLES, assetIdOf, normalizeModel, quarantineDir } = await import('../assets/cc0/normalize.mjs');
  const { CC0, CC0_CACHE, cc0Packs, cc0Refusal, profileLimits, replaceModels, replaceRefusal } = await import('../p37d/promote-batch.mjs');
  const { paletteOf, scoreSheet } = await import('../p37d/judge-sheet.mjs');
  const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const apply = args.includes('--apply');
  const only = flag('--only')?.split(',');
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  const judge = read('evals/play/p57/judge.json');
  const usage = read('evals/play/p57/usage.json');
  const catalog = read('src/assets/catalog.json');
  const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : { models: {} };
  const kit = read('evals/play/p57/kit-missing.json');
  const byId = new Map(catalog.assets.map((asset) => [asset.assetId, asset]));
  const leafOf = new Map(sheetEntries(usage).filter((entry) => entry.leaf).map((entry) => [entry.id, entry.leaf]));
  const packs = cc0Packs();
  const out = path.resolve(flag('--out', 'D:/caches/p57/cc0-veg'));
  assertNotTrainingDir(out);
  mkdirSync(out, { recursive: true });
  const stateFile = path.join(out, 'state.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { startedAt: new Date().toISOString(), prep: {}, licences: {}, models: {} };
  const saveState = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`);

  // Soubory, které už katalog používá: CC0 modely z výběru P26A a dřívější CC0 výměny (týž model dvakrát nechceme).
  const selection = JSON.parse(readFileSync(path.join(ROOT, 'scripts/assets/cc0/selection.json'), 'utf8'));
  const skip = new Set(selection.selected.filter((entry) => byId.has(assetIdOf(entry)) && !byId.get(assetIdOf(entry)).provenance.replacedAt).map((entry) => `${entry.pack}/${entry.file}`));
  for (const asset of catalog.assets.filter((asset) => asset.provenance.replacedAt && asset.provenance.license === CC0)) {
    const [, file, pack] = /^CC0 model (.+) from the ([\w-]+) pack/.exec(asset.provenance.source) ?? [];
    if (file) skip.add(`${pack}/${file}`);
  }
  const models = packModels(JSON.parse(readFileSync(path.join(ROOT, 'scripts/assets/cc0/fetched.json'), 'utf8')));
  const { targets, outside } = vegTargets({ judge, usage, catalog, report, kit });
  const todo = targets.filter((target) => !only || only.includes(target.id));
  console.log(`cc0-veg: ${todo.length} targets (${todo.map((target) => target.id).join(', ')}); kit vegetation outside the catalog: ${outside.map((entry) => entry.noun).join(', ') || 'none'}`);

  const packArg = (pack) => ({ id: pack.id, pageUrl: pack.pageUrl, author: pack.author, license: pack.license });
  const licenseFileOf = (pack) => path.join(CC0_CACHE, `${pack.id}.license.txt`);
  /** Soubor z balíku jako ostatní CC0 modely katalogu (`--style`: paleta, statický, metry, pivot dole). */
  const prepare = async (pack, file) => {
    const key = `${pack.id}/${file}`;
    if (state.prep[key]) return state.prep[key];
    const scratch = `p57veg-${shuffleKey('prep', key).slice(0, 10)}`;
    const glb = path.join(out, 'prep', pack.id, `${slug(file)}.glb`);
    try {
      const label = modelTokensOf(file).join(' ') || 'plant';
      const record = await normalizeModel({ input: path.join(CC0_CACHE, pack.id, file), assetId: scratch, label, tags: [label], pack: packArg(pack), licenseFile: licenseFileOf(pack), sourceFile: file, style: true, maxTriangles: HERO_MAX_TRIANGLES });
      mkdirSync(path.dirname(glb), { recursive: true });
      copyFileSync(record.lod0.file, glb);
      state.prep[key] = { glb, triangles: record.lod0.triangles };
    } catch (error) {
      state.prep[key] = { error: String(error.message).slice(0, 300) };
    } finally {
      rmSync(quarantineDir(scratch), { recursive: true, force: true });
    }
    return state.prep[key];
  };
  /** Zkouška výměny: tatáž normalizace a tytéž meze jako `replaceModels(..., { profile: 'hero' })`; `null` = projde. */
  const preflight = async (old, glb, pack, file) => {
    const scratch = `p57veg-${shuffleKey('try', `${old.assetId}|${glb}`).slice(0, 10)}`;
    try {
      const record = await normalizeModel({ input: glb, assetId: scratch, label: old.tags[0], tags: old.tags, pack: packArg(pack), licenseFile: licenseFileOf(pack), sourceFile: file, style: false, ...profileLimits(old, 'hero') });
      return replaceRefusal(old, record);
    } catch (error) {
      return `normalize: ${error.message}`;
    } finally {
      rmSync(quarantineDir(scratch), { recursive: true, force: true });
    }
  };

  // 1. Kandidáti: licence, příprava, box, zkouška výměny.
  const items = [];
  for (const target of todo) {
    const old = byId.get(target.id);
    const query = queryFor(target.noun);
    let item = state.models[target.id];
    if (!item || item.oldHash !== old.hash) item = state.models[target.id] = { ...target, oldHash: old.hash, query: query?.key ?? null, candidates: [], duel: null };
    delete item.applied;
    delete item.refusedAt;
    items.push(item);
    for (const { pack: packId, file } of matchFiles(query, models, skip)) {
      const key = `${packId}/${file}`;
      if (item.candidates.some((candidate) => candidate.key === key)) continue;
      const candidate = { key, pack: packId, file };
      item.candidates.push(candidate);
      const refusal = cc0Refusal({ licence: CC0, source: { pack: packId, file } });
      if (!state.licences[packId]) state.licences[packId] = { declared: packs.get(packId)?.license ?? null, text: path.join(CC0_CACHE, `${packId}.license.txt`), check: refusal ?? 'CC0-1.0 in sources.json and in the pack licence text' };
      if (refusal) {
        candidate.licence = refusal;
        continue;
      }
      candidate.licence = CC0;
      const prep = await prepare(packs.get(packId), file);
      if (prep.error) {
        candidate.prep = prep.error;
        continue;
      }
      const glb = path.join(out, 'fit', target.id, `${slug(file)}-${shuffleKey('fit', key).slice(0, 6)}.glb`);
      mkdirSync(path.dirname(glb), { recursive: true });
      Object.assign(candidate, await fit(prep.glb, glb, dimsOf(old.bounds), HERO_MAX_TRIANGLES));
      if (candidate.fit === 'ok') {
        candidate.glb = glb;
        candidate.refused = await preflight(old, glb, packs.get(packId), file);
      }
      saveState();
    }
    saveState();
    const ready = item.candidates.filter((candidate) => candidate.glb && !candidate.refused).length;
    console.log(`${target.id} (${target.noun}): query ${item.query ?? '-'}, ${item.candidates.length} files, ${ready} fit the old box and pass the replace check`);
  }

  // 2. Skóre 1–10 od Opuse na mřížkách 3×3 (jen nesouzení); buňka nese jen číslo, žádné jméno.
  const cells = items.flatMap((item) => item.candidates.filter((candidate) => candidate.glb && !candidate.refused && candidate.score === undefined)
    .map((candidate) => ({ id: `cell-${shuffleKey('cell', `${item.id}|${candidate.key}`).slice(0, 10)}`, glb: candidate.glb, leaf: leafOf.get(item.id), candidate })))
    .sort((a, b) => shuffleKey('cc0-veg', a.id).localeCompare(shuffleKey('cc0-veg', b.id)));
  if (cells.length > 0) {
    const sheets = path.join(out, `score-${shuffleKey('cells', cells.map((cell) => cell.id).join(',')).slice(0, 8)}`);
    mkdirSync(sheets, { recursive: true });
    writeFileSync(path.join(sheets, 'glb-list.json'), JSON.stringify(cells.map(({ id, glb }) => ({ id, glb }))));
    writeFileSync(path.join(sheets, 'ids.json'), JSON.stringify(cells.map(({ id, leaf }) => (leaf ? { id, leaf } : { id }))));
    spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--grid', '3', '--glb-list', path.join(sheets, 'glb-list.json'), '--ids', path.join(sheets, 'ids.json'), '--out', sheets], { stdio: 'inherit' });
    const queue = [...JSON.parse(readFileSync(path.join(sheets, 'grid-index.json'), 'utf8')).sheets];
    const byCell = new Map(cells.map((cell) => [cell.id, cell.candidate]));
    const worker = async () => {
      for (let sheet = queue.shift(); sheet !== undefined; sheet = queue.shift()) {
        const png = path.join(sheets, `${sheet.sheet}.png`);
        let got = (await scoreSheet(png, sheet.cells.length, path.join(out, 'judge'), 'claude')).cells;
        if (got.some((cell) => cell === null)) got = mergeAttempts(got, (await scoreSheet(png, sheet.cells.length, path.join(out, 'judge'), 'claude')).cells);
        sheet.cells.forEach((id, index) => Object.assign(byCell.get(id), { score: got[index]?.score ?? null, name: got[index]?.name ?? null, reason: got[index]?.reason ?? null, sheet: `${path.basename(sheets)}/${sheet.sheet}#${index + 1}` }));
        saveState();
        console.log(`${sheet.sheet}: ${got.map((cell) => cell?.score ?? '-').join(' ')}`);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  // 3. Souboj nejlepšího se současným modelem.
  const today = new Date().toISOString().slice(0, 10);
  for (const item of items) {
    const best = bestCandidate(item.candidates);
    if (!best || (item.duel?.candidate === best.key && item.duel.oldHash === item.oldHash)) continue;
    const old = byId.get(item.id);
    const votes = await runDuel({
      key: `${item.id}-cc0-${shuffleKey('duel-key', `${best.key}|${item.oldHash}`).slice(0, 8)}`,
      oldGlb: path.join(ROOT, 'public', old.lods.find((lod) => lod.level === 0).path), newGlb: best.glb,
      leaf: leafOf.get(item.id), dir: path.join(out, 'duel'), seed: Number.parseInt(shuffleKey('duel', `${item.id}|${best.key}`).slice(0, 8), 16),
      takeCodex: () => takeCodexCall(COUNTER, today, CODEX_DAILY_CAP - CODEX_RESERVE),
    });
    item.duel = { candidate: best.key, oldHash: item.oldHash, votes };
    saveState();
  }

  // 4. Výměna (jen `--apply`) a souhrn.
  if (apply) {
    const winners = items.filter((item) => vegResult(item) === 'replace');
    const entries = [];
    for (const item of winners) {
      const best = bestCandidate(item.candidates);
      entries.push({
        id: item.id, nouns: [item.noun], glb: best.glb, bounds: best.dims, palette: await paletteOf(best.glb),
        source: { pack: best.pack, file: best.file }, licence: CC0,
        checked: { judge: `P57 T8r CC0 vegetation: blind 1-10 grid, Opus 5.5: ${best.score}; duel ${item.duel.votes.map((vote) => `${vote.judge} ${vote.vote}`).join(', ')}`, verdict: 'pass' },
      });
    }
    const batch = { schema: 'catalog-batch.v1', entries };
    writeFileSync(path.join(out, 'catalog-batch.json'), `${JSON.stringify(batch, null, 1)}\n`);
    const { replaced, skipped } = entries.length > 0 ? await replaceModels(batch, { profile: 'hero', origin: 'cc0' }) : { replaced: [], skipped: [] };
    for (const item of winners) {
      const refused = skipped.find((entry) => entry.id === item.id)?.reason;
      if (replaced.includes(item.id)) item.applied = 'replaced';
      else {
        item.applied = 'refused';
        item.refusedAt = refused ?? 'not replaced';
      }
    }
    saveState();
  }
  const section = {
    about: 'P57 T8r item 4 (owner decision 22 Oct): vegetation the 3D generator draws badly, taken from CC0 packs already on disk instead. Targets: vegetation among the top-50 targets not yet replaced, plus kit-missing vegetation the catalog has below 6. Candidates by file name from packs whose CC0-1.0 licence is declared in scripts/assets/cc0/sources.json and stated in the licence text shipped in the pack; styled like the other CC0 catalog models, fitted into the old box (scripts/p57/regen.mjs fit) and checked against the replace rules (bounds +-10 %, LOD1 at most the old one). Opus 5.5 scores them blind 1-10 on 3x3 grids; the best at >= 6 duels the current model blind (scripts/p57/duel.mjs). replaced = won both duel votes and swapped in by promote-batch replaceModels (origin cc0, profile hero). No CC0 match = the id stays with the generator.',
    updatedAt: new Date().toISOString(),
    models: { ...Object.fromEntries(Object.entries(report.cc0Veg?.models ?? {}).filter(([, model]) => model.result === 'replaced')), ...Object.fromEntries(items.map((item) => [item.id, vegSummary(item)])) },
    kitOutside: outside,
  };
  writeFileSync(path.join(out, 'section.json'), `${JSON.stringify(section, null, 1)}\n`);
  if (apply) {
    const fresh = JSON.parse(readFileSync(REPORT, 'utf8'));
    fresh.cc0Veg = section;
    fresh.summary = heroSummary(usage, judge, fresh.models, section.models);
    writeFileSync(REPORT, `${JSON.stringify(fresh, null, 1)}\n`);
  }
  for (const item of items) {
    const summary = section.models[item.id];
    console.log(`${item.id}: ${summary.result}${summary.file ? ` – ${summary.pack}/${summary.file} score ${summary.score}` : ''}${summary.duel ? ` duel ${summary.duel.map((vote) => vote.vote ?? '-').join('+')}` : ''}${summary.reason ? ` (${summary.reason})` : ''}`);
  }
  console.log(apply ? `cc0-veg: applied, top50.json cc0Veg written` : `cc0-veg: dry run, nothing written to the repo; preview in ${path.join(out, 'section.json')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
