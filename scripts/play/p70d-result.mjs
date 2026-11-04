/**
 * P70D T5: výsledek slepého soudu před/po a FPS brány telefonu. Čisté funkce (strana snímku na listu, verdikt,
 * souhrn) + zápis `evals/play/p70d/result.md`.
 *
 *   node scripts/play/p70d-result.mjs   (čte `evals/play/p70d/after/{judge,fps-before,fps}.json`)
 *
 * Brána: „po“ vyhraje aspoň `WIN_MIN` z 8 scén a žádná scéna neztratí víc než `FPS_DROP_MAX` FPS (medián,
 * prokládané A,B – `p70d-shots.mjs fps --vs`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIN_MIN = 6;
export const FPS_DROP_MAX = 0.05;
export const SALT = 'p70d-t5';

/** FNV-1a – stejný vstup, stejná strana; soudce vidí jen list, ne tuhle funkci. */
const fnv = (text) => {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
};

/** Kde na listu leží snímek „po“: `A` = vlevo, `B` = vpravo. */
export const afterSideOf = (id, salt = SALT) => (fnv(`${salt}:${id}`) % 2 === 0 ? 'A' : 'B');

/** Volba soudce (`A`/`B`) → která verze vyhrála; bez volby `null`. */
export const verdictOf = (pick, afterSide) => (pick === 'A' || pick === 'B' ? (pick === afterSide ? 'after' : 'before') : null);

const median = (row) => (typeof row?.fpsMedian === 'number' ? row.fpsMedian : null);

/**
 * Souhrn: verdikt a FPS před/po pro každou scénu. `drop` = poměrná ztráta FPS (záporná = zrychlení);
 * scéna bez měření FPS bránou neprojde (`fpsOk: false`), scéna bez verdiktu se nepočítá jako výhra.
 */
export function summarize({ scenes, verdicts, before, after }) {
  const rows = scenes.map((id) => {
    const fpsBefore = median(before.find((row) => row.id === id));
    const fpsAfter = median(after.find((row) => row.id === id));
    const drop = fpsBefore !== null && fpsAfter !== null && fpsBefore > 0 ? (fpsBefore - fpsAfter) / fpsBefore : null;
    return { id, verdict: verdicts[id] ?? null, fpsBefore, fpsAfter, drop, fpsOk: drop !== null && drop <= FPS_DROP_MAX };
  });
  const afterWins = rows.filter((row) => row.verdict === 'after').length;
  const fpsOk = rows.every((row) => row.fpsOk);
  return { rows, afterWins, judged: rows.filter((row) => row.verdict !== null).length, fpsOk, pass: afterWins >= WIN_MIN && fpsOk };
}

const pct = (value) => (value === null ? '–' : `${(value * -100).toFixed(1).replace('-0.0', '0.0')} %`);
const num = (value) => (value === null ? '–' : value.toFixed(1));

/** `result.md`: tabulka scéna × (soud, FPS před/po), pod ní snímky vedle sebe (3. vteřina). */
export function resultMarkdown(summary, measuredAt) {
  const lines = [
    '# P70D – slepý soud před/po a FPS telefonu',
    '',
    `Měřeno ${measuredAt}. Soud: \`codex exec -i\` nad \`sheet.png\` v prázdném dočasném adresáři, strana snímku „po“ ze semínka (\`afterSideOf\`). FPS: Pixel 7, CPU 4×, mediány prokládaných běhů (baseline \`0d3fa930\` proti \`main\` po T2–T4).`,
    '',
    `**Brána:** „po“ vyhrálo ${summary.afterWins} z ${summary.rows.length} (cíl ≥ ${WIN_MIN}) · FPS ${summary.fpsOk ? 'bez poklesu přes 5 %' : 'PORUŠENO u některé scény'} · **${summary.pass ? 'PROŠLO' : 'NEPROŠLO'}**`,
    '',
    '| Scéna | Soud | FPS před | FPS po | Změna |',
    '|---|---|---|---|---|',
    ...summary.rows.map((row) => `| ${row.id} | ${row.verdict ?? 'bez odpovědi'} | ${num(row.fpsBefore)} | ${num(row.fpsAfter)} | ${pct(row.drop)}${row.fpsOk ? '' : ' ⚠'} |`),
    '',
    '## Snímky (3. vteřina): před | po',
    '',
    ...summary.rows.flatMap((row) => [`### ${row.id}`, '', `![před](baseline/${row.id}-03s.png) ![po](after/${row.id}-03s.png)`, '']),
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../evals/play/p70d');
  const read = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  const judge = read('after/judge.json');
  const before = read('after/fps-before.json');
  const after = read('after/fps.json');
  const summary = summarize({ scenes: Object.keys(judge.verdicts), verdicts: judge.verdicts, before: before.rows, after: after.rows });
  writeFileSync(resolve(root, 'result.md'), `${resultMarkdown(summary, after.measuredAt ?? '?')}\n`);
  console.log(JSON.stringify({ afterWins: summary.afterWins, fpsOk: summary.fpsOk, pass: summary.pass, rows: summary.rows.map((row) => `${row.id} ${row.verdict} ${num(row.fpsBefore)}→${num(row.fpsAfter)}`) }));
}
