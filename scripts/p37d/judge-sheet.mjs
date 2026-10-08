#!/usr/bin/env node
/**
 * Slepý soudce nových modelů (P37D T2): list čtyř pohledů → astra přes předplatné
 * (`codex exec -i`) → „co to je?“ bez jména → shoda se slovem dávky.
 *
 *   node scripts/p37d/judge-sheet.mjs --record <batch.json> --out <adresář> [--concurrency 3]
 *     [--aliases <aliases.json>] [--batch-out <catalog-batch.json> [--viewed <pilot.json>]]
 *   node scripts/p37d/judge-sheet.mjs --precheck <image.png> --noun <jméno> --out <adresář>
 *
 * `--precheck` (P45E T2) se zeptá na jeden 2D obrázek před TRELLIS stejnou cestou a shodou;
 * volá ho `ops/gen3d/precheck.py`.
 * `--aliases` je `{ "jméno": ["synonymum", …] }` (`evals/play/p37d/aliases.json`): odpověď
 * se porovná se všemi jmény záznamu a synonyma jdou v dávce do `nouns`.
 * `--batch-out` zapíše dávku `catalog-batch.v1` (`src/play/assets/batch.ts`) pro
 * `scripts/p37d/promote-batch.mjs`: každý souzený model s verdiktem `pass`/`fail`.
 * `--viewed` je soubor s `records[].viewed` („accept …“ / „reject …“) z prohlédnutí
 * listů; ten verdikt soudce přebije a jde do `checked.judge`.
 *
 * `--record` je záznam `ops/gen3d/batch.py`; soudí se jen modely, které prošly bránou
 * kvality. Listy kreslí `scripts/assets/qa-sheets.mjs --glb-list`, odpovědi a verdikty
 * leží v `<out>/judge.json` – mimo repo a nikdy v trénovacích datech (podmínky OpenAI).
 * Hotová odpověď se při dalším běhu nepřeptává.
 *
 * Shoda: všechna slova jména jsou v odpovědi („rope“ ~ „coiled rope“), nebo se shoduje
 * hlava („water gun“ ~ „toy gun“). Hodnotí se nejpravděpodobnější jméno (`top1`)
 * i tři další (`top3`); model je přijatý, když sedí kterékoli z nich a soudce ho
 * zároveň vidí neporušený (`intact`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { wordsOf } = await import('./missing-nouns.mjs');
const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');

export const QUESTION =
  'The attached image is a contact sheet of ONE 3D game model seen from four angles (front, side, top, and 3/4 next to a 1 m cube). Which single object does it depict? Reply only with the JSON the schema asks for: name = the most likely common English noun (1-3 words), alternatives = up to 3 other plausible names, recognizable = false when no object can be made out, intact = false only for SEVERE damage: the object falls apart into torn shreds or loose fragments, has large holes through it, or is a melted blob nobody could use in a game. Rough low-poly faceting, crumpled or noisy shading and small dents still count as intact.';

/** Předkontrola obrázku před TRELLIS (P45E T2): scéna, víc věcí nebo useknutá věc se do sítě nehodí. */
export const IMAGE_QUESTION =
  'The attached image is a picture meant to be turned into ONE 3D game model. Which single object does it depict? Reply only with the JSON the schema asks for: name = the most likely common English noun (1-3 words), alternatives = up to 3 other plausible names, recognizable = false when no object can be made out, intact = false when the picture shows a scene or several separate objects instead of one, or the object is cut off by the image edge.';

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'alternatives', 'recognizable', 'intact'],
  properties: {
    name: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    recognizable: { type: 'boolean' },
    intact: { type: 'boolean' },
  },
};

/** Jméno dávky a odpověď soudce: všechna slova jména v odpovědi, nebo stejná hlava. */
export function matches(noun, guess) {
  const want = wordsOf(noun.replaceAll('-', ' '));
  const got = wordsOf(guess.replaceAll('-', ' '));
  if (want.length === 0 || got.length === 0) return false;
  return want.every((word) => got.includes(word)) || want.at(-1) === got.at(-1);
}

/**
 * `top1` = sedí hlavní jméno, `top3` = sedí jen alternativa, `no` = nic, `broken` = potrhaná
 * síť – poznatelná, ale potrhaná veverka (QA 26. 9.) do hry nepatří. Přijaté jsou `top1` a `top3`.
 * Otázka se ptá jen na vážné poškození: širší „čistý asset“ shodil 7 z 16 modelů, které
 * dřív schválil člověk (kalibrace 3. 10., `evals/play/p37d/pilot.md`).
 * `names` jsou všechna jména záznamu: pilotní „bug“ soudce nazval „beetle“ a „investor“
 * „businessman“ – obojí správně, a přesto ruční přijetí.
 */
export function verdictOf(names, answer) {
  if (!answer.intact) return 'broken';
  if (!answer.recognizable) return 'no';
  const hit = (guess) => [names].flat().some((noun) => matches(noun, guess));
  if (hit(answer.name)) return 'top1';
  return answer.alternatives.some(hit) ? 'top3' : 'no';
}

const slug = (noun) => noun.replaceAll(' ', '-');

const toSrgb = (linear) => Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));

/** Barvy vrcholů jako sRGB hex, nejčastější první; `COLOR_0` je podle spec lineární. */
export async function paletteOf(glb, max = 16) {
  const { NodeIO } = await import('@gltf-transform/core');
  const doc = await new NodeIO().read(glb);
  const counts = new Map();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const colour = primitive.getAttribute('COLOR_0');
      for (let i = 0, element = []; colour && i < colour.getCount(); i++) {
        colour.getElement(i, element);
        const hex = `#${element.slice(0, 3).map((value) => toSrgb(value).toString(16).padStart(2, '0')).join('')}`;
        counts.set(hex, (counts.get(hex) ?? 0) + 1);
      }
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, max).map(([hex]) => hex);
}

const IMAGE_MODELS = { klein: 'FLUX.2-klein-4B', zimage: 'Z-Image-Turbo' };

/**
 * Dávka `catalog-batch.v1` ze záznamu výroby a verdiktů soudce. Model bez odpovědi
 * soudce (chyba codexu) do dávky nejde; prohlédnutí (`viewed`) verdikt přebije.
 * Synonyma z `aliases` jdou do `nouns` za hlavní jméno – soudce je uznal, katalog je pozná.
 */
export async function catalogBatch(models, results, viewed = new Map(), aliases = {}) {
  const config = readFileSync(path.join(ROOT, 'ops/gen3d/config.toml'), 'utf8');
  const imageModel = IMAGE_MODELS[/^image_model\s*=\s*"(\w+)"/m.exec(config)[1]];
  const entries = [];
  for (const record of models) {
    const judged = results[record.noun]?.verdict;
    if (!judged) continue;
    const look = viewed.get(record.noun);
    const pass = look ? look.startsWith('accept') : judged === 'top1' || judged === 'top3';
    const meta = JSON.parse(readFileSync(path.join(path.dirname(record.glb), 'meta.json'), 'utf8'));
    entries.push({
      id: `gen3d-${slug(record.noun)}`,
      nouns: [record.noun, ...(aliases[record.noun] ?? [])],
      glb: record.glb,
      lod1: record.lod1,
      bounds: meta.gate.stats.extentsM,
      palette: await paletteOf(record.glb),
      source: { pipeline: 'ops/gen3d', imageModel, shapeModel: 'TRELLIS.2-4B', seed: record.seed },
      licence: 'LicenseRef-Worldsmith-Generated',
      checked: { judge: `blind four-view sheet: ${judged}${look ? `; viewed: ${look}` : ''}`, verdict: pass ? 'pass' : 'fail' },
    });
  }
  return { schema: 'catalog-batch.v1', entries };
}

/** `codex.cmd` by šel jen přes shell, který otázku rozseká na slova; `codex.js` přímo přes node ne (vzor `scripts/codex-shim.mjs`). */
const CODEX = process.platform === 'win32'
  ? { file: process.execPath, prefix: [path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] }
  : { file: 'codex', prefix: [] };

/**
 * Soudce vidí cestu k obrázku i svůj pracovní adresář; list `ramp.png` vedle `glb-list.json`
 * mu jméno prozradil (dveře nazval „ramp“, 3. 10.). Každá otázka proto dostane prázdný
 * adresář s `sheet.png`, a odpověď se přesune pod jméno až potom.
 */
export function blindQuestion(sheet, schemaFile, question = QUESTION) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  copyFileSync(sheet, path.join(cwd, 'sheet.png'));
  copyFileSync(schemaFile, path.join(cwd, 'schema.json'));
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', 'tools.web_search=false', '-i', 'sheet.png', '--output-schema', 'schema.json', '-o', 'answer.json', question];
  return { cwd, args };
}

/** Jedna otázka soudci nad listem; `answerFile` dostane odpověď, když codex nějakou zapsal. */
export function ask(sheet, schemaFile, answerFile, question = QUESTION) {
  const { cwd: blind, args } = blindQuestion(sheet, schemaFile, question);
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(CODEX.file, [...CODEX.prefix, ...args], { cwd: blind, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (existsSync(path.join(blind, 'answer.json'))) copyFileSync(path.join(blind, 'answer.json'), answerFile);
      // Vnuk codexu může adresář ještě chvíli držet (EBUSY, 4. 10.); prázdný adresář v tempu nevadí.
      try {
        rmSync(blind, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch { /* zůstane v tempu */ }
      done({ code, seconds: Math.round((Date.now() - started) / 100) / 10, stderr: stderr.slice(-400) });
    });
  });
}

/**
 * Jeden obrázek, jedna slepá otázka (`ops/gen3d/precheck.py`); odpověď a verdikt jdou do
 * `<out>/precheck.jsonl` a jako poslední řádek na výstup. Bez odpovědi `unavailable`.
 */
async function precheck(image, noun, out, names) {
  const schemaFile = path.join(out, 'answer-schema.json');
  writeFileSync(schemaFile, JSON.stringify(ANSWER_SCHEMA));
  mkdirSync(path.join(out, 'answers'), { recursive: true });
  const answerFile = path.join(out, 'answers', `${slug(noun)}-${Date.now()}.json`);
  const run = await ask(image, schemaFile, answerFile, IMAGE_QUESTION);
  let line;
  try {
    const answer = JSON.parse(readFileSync(answerFile, 'utf8'));
    line = { noun, verdict: verdictOf(names, answer), answer, seconds: run.seconds };
  } catch {
    line = { noun, verdict: 'unavailable', error: `codex exit ${run.code}: ${run.stderr}`, seconds: run.seconds };
  }
  appendFileSync(path.join(out, 'precheck.jsonl'), `${JSON.stringify(line)}\n`);
  console.log(JSON.stringify(line));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const out = path.resolve(flag('--out', 'D:/caches/p37d/pilot'));
  const concurrency = Number(flag('--concurrency', '3'));
  assertNotTrainingDir(out);
  mkdirSync(path.join(out, 'answers'), { recursive: true });
  const aliasFile = flag('--aliases');
  const aliases = aliasFile ? JSON.parse(readFileSync(path.resolve(aliasFile), 'utf8')) : {};
  const namesOf = (noun) => [noun, ...(aliases[noun] ?? [])];

  const image = flag('--precheck');
  if (image) {
    await precheck(path.resolve(image), flag('--noun'), out, namesOf(flag('--noun')));
    return;
  }

  const { records } = JSON.parse(readFileSync(path.resolve(flag('--record')), 'utf8'));
  const models = records.filter((record) => record.verdict === 'passed' && existsSync(record.glb));
  const list = path.join(out, 'glb-list.json');
  writeFileSync(list, JSON.stringify(models.map((record) => ({ id: slug(record.noun), glb: record.glb })), null, 1));
  const sheets = path.join(out, 'sheets');
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--glb-list', list, '--out', sheets], { stdio: 'inherit' });

  const schemaFile = path.join(out, 'answer-schema.json');
  writeFileSync(schemaFile, JSON.stringify(ANSWER_SCHEMA));
  const resultFile = path.join(out, 'judge.json');
  const results = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : {};
  // Hotová odpověď se nepřeptává, ale verdikt se přepočte – synonyma mohla přibýt.
  for (const [noun, result] of Object.entries(results)) if (result.answer) result.verdict = verdictOf(namesOf(noun), result.answer);
  const queue = models.filter((record) => existsSync(path.join(sheets, `${slug(record.noun)}.png`)) && results[record.noun]?.answer === undefined);
  const worker = async () => {
    for (let record = queue.shift(); record !== undefined; record = queue.shift()) {
      const answerFile = path.join(out, 'answers', `${slug(record.noun)}.json`);
      const run = await ask(path.join(sheets, `${slug(record.noun)}.png`), schemaFile, answerFile);
      let answer;
      try {
        answer = JSON.parse(readFileSync(answerFile, 'utf8'));
      } catch {
        results[record.noun] = { error: `codex exit ${run.code}: ${run.stderr}`, seconds: run.seconds };
        continue;
      }
      results[record.noun] = { answer, verdict: verdictOf(namesOf(record.noun), answer), seconds: run.seconds };
      writeFileSync(resultFile, `${JSON.stringify(results, null, 1)}\n`);
      console.log(`${record.noun}: ${answer.name} [${answer.alternatives.join(', ')}] -> ${results[record.noun].verdict}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeFileSync(resultFile, `${JSON.stringify(results, null, 1)}\n`);
  const judged = Object.values(results).filter((result) => result.verdict);
  const accepted = judged.filter((result) => result.verdict === 'top1' || result.verdict === 'top3').length;
  console.log(`judged ${judged.length}/${models.length}, accepted ${accepted} (top1 ${judged.filter((result) => result.verdict === 'top1').length})`);

  const batchOut = flag('--batch-out');
  if (batchOut) {
    const viewedFile = flag('--viewed');
    const viewed = new Map(viewedFile ? JSON.parse(readFileSync(viewedFile, 'utf8')).records.map((record) => [record.noun, record.viewed]) : []);
    const batch = await catalogBatch(models, results, viewed, aliases);
    writeFileSync(path.resolve(batchOut), `${JSON.stringify(batch, null, 1)}\n`);
    console.log(`batch ${batchOut}: ${batch.entries.filter((entry) => entry.checked.verdict === 'pass').length} pass of ${batch.entries.length}`);
  }
}

if (isMain) await main();
