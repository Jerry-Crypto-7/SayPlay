#!/usr/bin/env node
/**
 * P16 T4 – slepý kontaktní arch a odhalení.
 *
 *   build   z `results.json` a fotek postaví `sheet.html` (fotky jako data URI,
 *           v každé větě zamíchané pod písmeny A–G) a klíč do `key.json`
 *   reveal  z `ratings.json` a klíče spočítá tabulku a vítěze → `decision.md`
 *
 * Arch nesmí prozradit variantu: žádné jméno, cesta k fotce ani pořadí, které
 * by se opakovalo mezi větami. Klíč je jen v `key.json`. Pravidlo vítěze je
 * zapsané tady předem (`pickWinner`), ne vybrané až po pohledu na čísla.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'worldstream', 'effort');
const LETTERS = 'ABCDEFGHIJ';

/** Vyřadí variantu, jejíž p95 času do živého světa je nad tímhle – rezerva pod 300 s Vercelu. */
export const P95_LIMIT_MS = 240_000;
/** Víc selhání z osmi než tohle variantu vyřadí. */
export const FAILURE_LIMIT = 1;

/** Malý PRNG se semínkem – míchání musí jít zopakovat ze semínka v klíči. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildKey(variants, sentences, seed) {
  const random = mulberry32(seed);
  const sections = {};
  for (const sentence of sentences) {
    const order = [...variants];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    sections[sentence] = Object.fromEntries(order.map((variant, index) => [LETTERS[index], variant]));
  }
  return { seed, sections };
}

export function reveal(key, ratings) {
  const back = {};
  for (const [sentence, byLetter] of Object.entries(ratings)) {
    const section = key.sections[sentence];
    if (section === undefined) throw new Error(`the ratings name sentence ${sentence}, which the key does not have`);
    for (const [letter, score] of Object.entries(byLetter)) {
      const variant = section[letter];
      if (variant === undefined) throw new Error(`the ratings name letter ${letter} in ${sentence}, which the key does not have`);
      if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error(`${sentence} ${letter}: a rating is a whole number 1–5, got ${score}`);
      (back[variant] ??= []).push(score);
    }
  }
  return back;
}

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * `sheetId` odděluje rozpracovaná hodnocení v `localStorage`: soubory z disku
 * sdílejí v Chromu jeden původ, takže bez něj by se hodnocení z jiného archu
 * propsala pod stejná písmena, která tu patří jiným variantám. Náhodné, ne
 * semínko – ze semínka a pořadí variant by šel klíč dopočítat.
 */
export function renderSheet(sections, sheetId = 'sheet') {
  const body = sections.map((section, index) => `
<section>
  <h2><span class="n">${index + 1}/${sections.length}</span> ${escape(section.prompt)}</h2>
  <div class="grid">${section.entries.map((entry) => `
    <figure data-section="${section.id}" data-letter="${entry.letter}">
      ${entry.photo === null
        ? '<div class="missing">world did not arrive</div>'
        : `<img src="${entry.photo}" alt="world ${entry.letter}" loading="lazy">`}
      <figcaption><b>${entry.letter}</b>${entry.photo === null ? '' : `<span class="stars">${[1, 2, 3, 4, 5].map((score) =>
        `<label><input type="radio" name="${section.id}:${entry.letter}" value="${score}">${score}</label>`).join('')}</span>`}</figcaption>
    </figure>`).join('')}
  </div>
</section>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>World rating sheet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg: #0c1216; --panel: #141d22; --ink: #e6edf0; --dim: #8fa3ad; --accent: #2bb3a3; --warn: #d8a13a; }
  body { margin: 0; padding: 24px 16px 120px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
  header, section { max-width: 1400px; margin: 0 auto 40px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; }
  .n { color: var(--dim); font-weight: 400; margin-right: 8px; }
  p { color: var(--dim); margin: 0 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  figure { margin: 0; background: var(--panel); border-radius: 8px; overflow: hidden; }
  img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; cursor: zoom-in; }
  img.zoom { position: fixed; inset: 0; width: 100vw; height: 100vh; object-fit: contain; background: #000; z-index: 10; cursor: zoom-out; aspect-ratio: auto; }
  .missing { aspect-ratio: 16 / 9; display: grid; place-items: center; color: var(--warn); border: 1px dashed var(--warn); box-sizing: border-box; }
  figcaption { display: flex; align-items: center; gap: 12px; padding: 8px 12px; }
  figcaption b { font-size: 18px; width: 20px; }
  .stars { display: flex; gap: 4px; flex-wrap: wrap; }
  .stars label { padding: 2px 10px; border: 1px solid #2c3a41; border-radius: 6px; cursor: pointer; }
  .stars label:has(input:checked) { background: var(--accent); border-color: var(--accent); color: #04110f; }
  .stars input { display: none; }
  footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: #0a0f12ee; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; padding: 8px 16px; border: 0; border-radius: 6px; background: var(--accent); color: #04110f; cursor: pointer; }
  textarea { flex: 1 1 300px; min-width: 0; height: 40px; background: var(--panel); color: var(--ink); border: 1px solid #2c3a41; border-radius: 6px; font: 12px ui-monospace, monospace; }
</style></head>
<body>
<header>
  <h1>Which world is best?</h1>
  <p>Each sentence was built by several variants; the letters are shuffled per sentence. Rate every world 1 (poor) to 5 (great) for how well it shows the sentence and how good it looks. Click a picture to enlarge it.</p>
</header>
${body}
<footer><button id="copy" type="button">Copy ratings</button><span id="count"></span><textarea id="out" readonly placeholder="ratings JSON appears here"></textarea></footer>
<script>
  const storageKey = 'ratings:${sheetId}';
  const inputs = [...document.querySelectorAll('input[type=radio]')];
  const total = new Set(inputs.map((input) => input.name)).size;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
  for (const input of inputs) if (saved[input.name] === Number(input.value)) input.checked = true;
  function collect() {
    const flat = {}, nested = {};
    for (const input of inputs) if (input.checked) {
      flat[input.name] = Number(input.value);
      const [section, letter] = input.name.split(':');
      (nested[section] ??= {})[letter] = Number(input.value);
    }
    return { flat, nested };
  }
  function update() {
    const { flat } = collect();
    document.getElementById('count').textContent = Object.keys(flat).length + ' / ' + total + ' rated';
    try { localStorage.setItem(storageKey, JSON.stringify(flat)); } catch {}
  }
  document.addEventListener('change', update);
  document.addEventListener('click', (event) => { if (event.target.tagName === 'IMG') event.target.classList.toggle('zoom'); });
  document.getElementById('copy').addEventListener('click', async () => {
    const text = JSON.stringify(collect().nested);
    const out = document.getElementById('out');
    out.value = text; out.select();
    try { await navigator.clipboard.writeText(text); } catch {}
  });
  update();
</script>
</body></html>
`;
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

/** Proč varianta vypadla, nebo `null`, když prošla. */
function dropped(stat) {
  if (stat.failures > FAILURE_LIMIT) return `${stat.failures} selhání (strop ${FAILURE_LIMIT})`;
  const p95 = percentile(stat.swapMs, 95);
  if (p95 === null) return 'žádný živý svět';
  if (p95 > P95_LIMIT_MS) return `p95 ${Math.round(p95 / 1000)} s nad ${P95_LIMIT_MS / 1000} s`;
  if (stat.ratings.length === 0) return 'bez hodnocení';
  return null;
}

export function pickWinner(stats) {
  const eligible = stats.filter((stat) => dropped(stat) === null);
  eligible.sort((a, b) => mean(b.ratings) - mean(a.ratings) || median(a.swapMs) - median(b.swapMs));
  return eligible[0]?.variant ?? null;
}

const readJson = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

function build() {
  const variants = readJson('variants.json').variants.map((variant) => variant.id);
  const sentences = readJson('sentences.json').sentences;
  const records = readJson('results.json').records;
  const missing = sentences.flatMap((sentence) => variants.filter((variant) => !records.some((r) => r.variant === variant && r.id === sentence.id)).map((variant) => `${variant}:${sentence.id}`));
  if (missing.length > 0) throw new Error(`results.json lacks ${missing.length} cases: ${missing.join(', ')} – finish the run first`);

  const key = buildKey(variants, sentences.map((sentence) => sentence.id), randomInt(1, 2 ** 31 - 1));
  const sections = sentences.map((sentence) => ({
    id: sentence.id,
    prompt: sentence.prompt,
    entries: Object.entries(key.sections[sentence.id]).map(([letter, variant]) => {
      const record = records.find((r) => r.variant === variant && r.id === sentence.id);
      return { letter, photo: record.outcome === 'swap' ? `data:image/jpeg;base64,${readFileSync(join(DIR, record.photo)).toString('base64')}` : null };
    }),
  }));
  writeFileSync(join(DIR, 'sheet.html'), renderSheet(sections, randomUUID()));
  writeFileSync(join(DIR, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
  console.log(`sheet.html: ${sections.length} sentences, ${sections.flatMap((s) => s.entries).filter((e) => e.photo !== null).length} worlds to rate; key in key.json`);
}

function revealToDecision() {
  const variants = readJson('variants.json').variants;
  const records = readJson('results.json').records;
  const key = readJson('key.json');
  const ratings = readJson('ratings.json');
  const unrated = records.filter((r) => r.outcome === 'swap').filter((r) => {
    const letter = Object.entries(key.sections[r.id]).find(([, variant]) => variant === r.variant)[0];
    return ratings[r.id]?.[letter] === undefined;
  });
  if (unrated.length > 0) throw new Error(`${unrated.length} arrived worlds have no rating – finish the sheet first`);

  const byVariant = reveal(key, ratings);
  const stats = variants.map((variant) => ({
    variant: variant.id,
    ratings: byVariant[variant.id] ?? [],
    swapMs: records.filter((r) => r.variant === variant.id && r.outcome === 'swap').map((r) => r.ms),
    failures: records.filter((r) => r.variant === variant.id && r.outcome !== 'swap').length,
  }));
  const winner = pickWinner(stats);
  const seconds = (ms) => (ms === null ? '–' : `${Math.round(ms / 1000)} s`);
  const rows = stats.map((stat) => {
    const variant = variants.find((v) => v.id === stat.variant);
    const average = mean(stat.ratings);
    return `| ${stat.variant} | ${variant.model}${variant.effort ? `@${variant.effort}` : ''} | ${average === null ? '–' : average.toFixed(2)} | ${seconds(median(stat.swapMs))} | ${seconds(percentile(stat.swapMs, 95))} | ${stat.failures} | ${dropped(stat) ?? (stat.variant === winner ? '**vítěz**' : 'prošla')} |`;
  });
  writeFileSync(join(DIR, 'decision.md'), `# P16 – který model a úsilí vyhrál slepé hodnocení

Vítěz: ${winner ?? 'nikdo – pravidlem neprošla žádná varianta'}

**n = 8 vět, jeden hodnotitel – není citovatelná míra.** Stačí na výběr modelu pro demo, ne na tvrzení v přihlášce.

Pravidlo zapsané před hodnocením (\`scripts/effort-sheet.mjs\`, \`pickWinner\`): vypadne varianta s víc než ${FAILURE_LIMIT} selháním z 8 (\`silent-fail\` + \`timeout\` + \`no-start\`) nebo s p95 času do živého světa nad ${P95_LIMIT_MS / 1000} s; mezi zbylými vyhraje nejvyšší průměr hodnocení (1–5, jen světy, které dorazily), při shodě nižší medián času. p95 je nejbližší pořadí, při 8 vzorcích tedy nejpomalejší výměna.

| Varianta | Model | Průměr | Medián času | p95 času | Selhání | Výsledek |
|---|---|---|---|---|---|---|
${rows.join('\n')}
`);
  console.log(`winner: ${winner ?? 'none'} → decision.md`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'build') build();
  else if (mode === 'reveal') revealToDecision();
  else { console.error('usage: node scripts/effort-sheet.mjs build | reveal'); process.exitCode = 2; }
}
