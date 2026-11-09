#!/usr/bin/env node
/**
 * P77 T1: diagnostika slepého soudce proti konceptu. Čte všechny běhy v `evals/play/p75/judge.json` (P75 `main`,
 * P75/P76 a P77 s HUD i bez něj) a pro každou z 12 vět sečte témata důvodů, kterými koncept vyhrál (slova důvodu →
 * téma, `THEMES`). Výstup `evals/play/p77/diag.md`: skóre s HUD a bez HUD (kolik rozdílu dělá rozhraní) a tři
 * nejčastější témata na větu.
 *
 *   node --experimental-strip-types --no-warnings scripts/play/p77-diag.mjs [--with p77-base] [--without p77-base-nohud]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';
import { outcome, passes } from './p75-judge.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Téma důvodu soudce podle slov; jeden důvod může nést víc témat. */
export const THEMES = [
  ['jednotný styl a dotažení kusů', /cohesive|consistent|unified|polish|finished|refined|crafted|quality|rough|placeholder|asset|prototype|primitive|basic/i],
  ['detail a materiály', /detail|texture|material|surface|clay|model/i],
  ['světlo a stíny', /light|lighting|shadow|sun|glow|atmospher|mood/i],
  ['barvy', /colou?r|palette|vibrant|saturat|warm|muted|dark|murky|dull/i],
  ['kompozice a hloubka', /composition|framing|frame|depth|foreground|focal|perspective|layer|camera|blur/i],
  ['rozhraní (HUD)', /\bUI\b|HUD|overlay|interface|\btext\b|label|button|menu/i],
  ['prázdná nebo plochá scéna', /empty|sparse|barren|flat|plain|bland|simple|minimal/i],
  ['čitelnost hrdiny a děje', /character|hero|readab|legib|clear|visible|action|gameplay|story/i],
  ['věrnost větě (prostředí)', /environment|setting|theme|world|city|volcano|underwater|space|castle|candy|orchard|icy|island/i],
];

const themesOf = (reason) => THEMES.filter(([, pattern]) => pattern.test(reason)).map(([name]) => name);

function main() {
  const options = args();
  const withHud = typeof options.with === 'string' ? options.with : 'p77-base';
  const withoutHud = typeof options.without === 'string' ? options.without : 'p77-base-nohud';
  const runs = JSON.parse(readFileSync(join(ROOT, 'evals', 'play', 'p75', 'judge.json'), 'utf8')).runs;
  const lines = [
    '# P77 T1 – výchozí stav a diagnostika bez HUD',
    '',
    `Skript \`scripts/play/p77-diag.mjs\` nad \`evals/play/p75/judge.json\` (soudce \`scripts/play/p75-judge.mjs\`, koncept A proti desktopovému snímku ve 3. s). Snímky: s HUD \`evals/play/p77/base/\` (\`p73d-shots.mjs\` nad \`origin/main\` a741b5b4), bez HUD \`evals/play/p77/base-nohud/\` (\`p77-shots.mjs --no-hud\`: všechno DOM nad plátnem skryté jen pro fotku, déšť zůstává).`,
    '',
    '## Skóre',
    '',
    '| běh | hra ≥ SAME | souzeno |',
    '|---|---|---|',
  ];
  for (const label of [withHud, withoutHud]) {
    const run = runs[label];
    if (run === undefined) {
      lines.push(`| ${label} | – | běh chybí |`);
      continue;
    }
    const { pass, judged } = passes(run);
    lines.push(`| ${label} | **${pass}/${judged}** | ${run.judgedAt.slice(0, 16).replace('T', ' ')} |`);
  }
  lines.push('', '## Proč koncept vyhrává – tři nejčastější témata na větu', '', `Ze všech běhů v \`judge.json\` (${Object.keys(runs).join(', ')}), jen důvody, kde vyhrál koncept. Témata podle slov důvodu (\`THEMES\` ve skriptu); v závorce kolikrát.`, '', '| # | věta | s HUD | bez HUD | 1. | 2. | 3. | důvod bez HUD |', '|---|---|---|---|---|---|---|---|');
  const total = new Map();
  for (const sentence of SENTENCES) {
    const counts = new Map();
    for (const run of Object.values(runs)) {
      const verdict = run.answers?.[sentence.id];
      if (outcome(verdict, run.key[sentence.id]) !== 'koncept') continue;
      for (const theme of themesOf(verdict.reason)) {
        counts.set(theme, (counts.get(theme) ?? 0) + 1);
        total.set(theme, (total.get(theme) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} (${n})`);
    const cell = (label) => {
      const run = runs[label];
      const result = run === undefined ? null : outcome(run.answers?.[sentence.id], run.key[sentence.id]);
      return result ?? '–';
    };
    const reason = runs[withoutHud]?.answers?.[sentence.id]?.reason?.replace(/\|/g, '/') ?? '–';
    lines.push(`| ${sentence.id} | ${sentence.text} | ${cell(withHud)} | ${cell(withoutHud)} | ${top[0] ?? '–'} | ${top[1] ?? '–'} | ${top[2] ?? '–'} | ${reason} |`);
  }
  lines.push('', '## Témata napříč větami', '', '| téma | kolikrát |', '|---|---|', ...[...total.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `| ${name} | ${n} |`), '');
  writeFileSync(join(ROOT, 'evals', 'play', 'p77', 'diag.md'), `${lines.join('\n')}\n`);
  console.log('diag.md hotovo');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
