#!/usr/bin/env node
/**
 * Druhý slepý soud nových modelů (P37D T5): náhodný vzorek modelů `gen3d-p37d` z katalogu,
 * list čtyř pohledů z GLB, který opravdu jde do hry, a jiná otázka než při přijetí –
 * „které z těchto pěti jmen?“ místo volného „co to je?“.
 *
 *   node scripts/p37d/judge-pick.mjs --seed <n> [--count 50] --out <adresář> [--concurrency 3]
 *
 * Vzorek, čtyři návnady a pořadí možností losuje `pure-rand` ze semínka, takže běh jde
 * zopakovat. Návnady jsou jména z `evals/play/p37d/missing.json`, žádné se nesmí shodovat
 * s žádným jménem modelu (`matches` oběma směry). Správně = soudce vybral hlavní jméno.
 * Otázka jde přes `ask()` z `judge-sheet.mjs`: prázdný adresář, `sheet.png`, astra přes
 * předplatné – vývojové měření, odpovědi v `<out>/pick.json`, nikdy v trénovacích datech.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { uniformInt } = await import('pure-rand/distribution/uniformInt');
const { xoroshiro128plus } = await import('pure-rand/generator/xoroshiro128plus');
const { ask, matches } = await import('./judge-sheet.mjs');
const { isOurs } = await import('./promote-batch.mjs');
const { assertNotTrainingDir } = await import('../assets/qa-astra.mjs');

const question = (options) =>
  'The attached image is a contact sheet of ONE 3D game model seen from four angles (front, side, top, and 3/4 next to a 1 m cube). ' +
  `Which of these five names fits it best: ${options.join(', ')}? Reply only with the JSON the schema asks for: choice = exactly one of the five names.`;

/** Modely výroby P37D v katalogu: hlavní jméno z popisku, pak štítky. */
export function ourModels(catalog) {
  return catalog.assets.filter(isOurs).map((asset) => {
    const main = asset.label.replace(/ \(generated\)$/, '');
    return { id: asset.assetId, names: [main, ...asset.tags.filter((tag) => tag !== main)], glb: path.join(ROOT, 'public', asset.lods[0].path) };
  });
}

/** Vzorek `count` modelů, každý s pěti možnostmi v losovaném pořadí; stejné semínko = stejný vzorek. */
export function drawSample(models, nouns, { seed, count }) {
  const rng = xoroshiro128plus(seed);
  const pool = [...models];
  const sample = [];
  while (sample.length < count && pool.length > 0) sample.push(pool.splice(uniformInt(rng, 0, pool.length - 1), 1)[0]);
  return sample.map((model) => {
    const decoys = nouns.filter((noun) => !model.names.some((name) => matches(name, noun) || matches(noun, name)));
    const options = [model.names[0]];
    while (options.length < 5) options.push(decoys.splice(uniformInt(rng, 0, decoys.length - 1), 1)[0]);
    for (let i = options.length - 1; i > 0; i--) {
      const j = uniformInt(rng, 0, i);
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { ...model, options };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const seed = Number(flag('--seed'));
  const count = Number(flag('--count', '50'));
  const out = path.resolve(flag('--out'));
  const concurrency = Number(flag('--concurrency', '3'));
  if (!Number.isInteger(seed)) throw new Error('--seed <integer> is required');
  assertNotTrainingDir(out);
  for (const dir of ['answers', 'schemas']) mkdirSync(path.join(out, dir), { recursive: true });

  const models = ourModels(JSON.parse(readFileSync(path.join(ROOT, 'src/assets/catalog.json'), 'utf8')));
  const nouns = JSON.parse(readFileSync(path.join(ROOT, 'evals/play/p37d/missing.json'), 'utf8')).missing.map((entry) => entry.noun);
  const sample = drawSample(models, nouns, { seed, count });
  const list = path.join(out, 'glb-list.json');
  writeFileSync(list, JSON.stringify(sample.map((model) => ({ id: model.id, glb: model.glb })), null, 1));
  const sheets = path.join(out, 'sheets');
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--glb-list', list, '--out', sheets], { stdio: 'inherit' });

  const resultFile = path.join(out, 'pick.json');
  const results = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : {};
  const queue = sample.filter((model) => existsSync(path.join(sheets, `${model.id}.png`)) && results[model.id]?.choice === undefined);
  const worker = async () => {
    for (let model = queue.shift(); model !== undefined; model = queue.shift()) {
      const schemaFile = path.join(out, 'schemas', `${model.id}.json`);
      writeFileSync(schemaFile, JSON.stringify({ type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { type: 'string', enum: model.options } } }));
      const answerFile = path.join(out, 'answers', `${model.id}.json`);
      const run = await ask(path.join(sheets, `${model.id}.png`), schemaFile, answerFile, question(model.options));
      try {
        const { choice } = JSON.parse(readFileSync(answerFile, 'utf8'));
        results[model.id] = { name: model.names[0], options: model.options, choice, correct: choice === model.names[0], seconds: run.seconds };
      } catch {
        results[model.id] = { name: model.names[0], options: model.options, error: `codex exit ${run.code}: ${run.stderr}` };
        continue;
      }
      writeFileSync(resultFile, `${JSON.stringify(results, null, 1)}\n`);
      console.log(`${model.id}: ${results[model.id].choice} ${results[model.id].correct ? 'ok' : 'WRONG'} [${model.options.join(', ')}]`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeFileSync(resultFile, `${JSON.stringify(results, null, 1)}\n`);
  const judged = sample.map((model) => results[model.id]).filter((result) => result?.choice !== undefined);
  const correct = judged.filter((result) => result.correct).length;
  console.log(`seed ${seed}: correct ${correct}/${judged.length} of ${sample.length} sampled (${Math.round((100 * correct) / Math.max(1, judged.length))} %) from ${models.length} models`);
}

if (isMain) await main();
