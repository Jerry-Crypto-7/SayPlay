/**
 * Výsledek jako text ke sdílení (P37C T4), po vzoru Wordle: mřížka bez
 * spoileru – jen to, jak běh dopadl (hvězdy, životy, kolik cílů), nic z hry
 * samotné – a cíl k překonání („Can you beat 2,450?“) s odkazem výzvy.
 *
 * Celý text se vejde do 280 znaků (počítáno v UTF-16, tedy přísněji než
 * sítě, které emoji váží dvěma): zkracuje se jen název hry, ostatní řádky
 * jsou krátké a pevné.
 */

import type { Stars } from './stars';

/** Co o skončeném běhu sdílení potřebuje; `null` = hra to nepočítá. */
export interface ShareRun {
  readonly won: boolean;
  /** Hra na přežití: výhra je vydržet, ne stihnout. */
  readonly survive: boolean;
  readonly seconds: number;
  readonly stars: Stars | null;
  readonly score: number | null;
  /** Zbylé životy (jen hra, která je má). */
  readonly lives: number | null;
  /** Cílové předměty běhu (`3 z 5`). */
  readonly goal: { readonly count: number; readonly need: number } | null;
}

export const SHARE_TEXT_MAX = 280;

/** Název hry delší než tohle se zkrátí, i když by se vešel. */
const TITLE_MAX = 60;

/** Nejvýš tolik políček má řádek cílů; víc cílů se do nich poměrově vejde. */
const GOAL_CELLS = 10;

/** Nejvýš tolik srdcí vedle sebe; víc životů se napíše číslem. */
const HEARTS_MAX = 5;

const BRAND = 'sayplay';

/** Název hry z titulku stránky `/play/<id>` („<název> – sayplay“); bez názvu `null`. */
export function gameName(documentTitle: string): string | null {
  const name = documentTitle.replace(/\s+[–-]\s+sayplay$/i, '').trim();
  return name === '' || name.toLowerCase() === BRAND ? null : name;
}

function grid(run: ShareRun): string {
  const marks: string[] = [];
  if (run.won && run.stars !== null) marks.push('⭐'.repeat(run.stars) + '☆'.repeat(3 - run.stars));
  if (run.lives !== null && run.lives > 0) marks.push(run.lives <= HEARTS_MAX ? '❤️'.repeat(run.lives) : `❤️×${String(run.lives)}`);
  if (run.goal !== null && run.goal.need > 0) {
    const cells = Math.min(run.goal.need, GOAL_CELLS);
    const done = Math.min(cells, Math.round((run.goal.count / run.goal.need) * cells));
    marks.push('🟩'.repeat(done) + '⬜'.repeat(cells - done));
  }
  if (marks.length === 0) marks.push(run.won ? '✅' : '❌');
  return marks.join(' ');
}

/** Cíl pro kamaráda: body, jinak čas; přežití nemá co zkrátit, prohra nemá číslo k překonání. */
function dareLine(run: ShareRun, time: string): string {
  if (!run.won) return 'So close. Can you beat it?';
  if (run.score !== null) return `Can you beat ${run.score.toLocaleString('en-US')}?`;
  return run.survive ? 'Can you survive it too?' : `Can you beat ${time}?`;
}

function clip(text: string, room: number): string {
  if (text.length <= room) return text;
  return room <= 1 ? '' : `${text.slice(0, room - 1).trimEnd()}…`;
}

/**
 * Text ke sdílení: název, mřížka, čas, cíl a odkaz – každý na svém řádku,
 * nejvýš `SHARE_TEXT_MAX` znaků. `url: null` = bez řádku odkazu – nabídka
 * sdílení ho dostane zvlášť a cíl by ho jinak zopakoval.
 */
export function shareText(run: ShareRun, title: string | null, url: string | null): string {
  const time = `${Math.max(0, run.seconds).toFixed(1)}s`;
  const rest = [grid(run), `⏱️ ${time}`, dareLine(run, time), ...(url === null ? [] : [url])];
  const suffix = ` – ${BRAND}`;
  const room = SHARE_TEXT_MAX - rest.join('\n').length - 1 - suffix.length;
  const name = title === null ? '' : clip(title, Math.min(TITLE_MAX, room));
  return [name === '' ? BRAND : `${name}${suffix}`, ...rest].join('\n');
}
