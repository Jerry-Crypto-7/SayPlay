import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BOT_PROFILES } from '../../arcade/verify';
import { assemblyOfCell, liveCells } from '../allowed';
import { compileRecipe } from '../compile';

/**
 * P66 T12: žánry, jejichž obtížnost drží vlastní test slabého robota (`<g>-bot` s prahem chyb prohraje), ne pásmo
 * začátečníka P41. Profil začátečníka je zpoždění a šum vstupu: ťukací hádanky s velkým časem (třídění, šipky) a díra
 * ho přežijí na 20/20, krádež ho prohraje na 16/20 (`evals/play/p66/README.md` → T12). Měření je zapsané a hlídá se
 * dál (běhy, chyby, přehrání, pokročilý ≥ 0,8); jen pásmo začátečníka se u nich nevynucuje – je to nález pro T15.
 */
// P68 T8/T11: závod s triky a stavbu obchodu začátečník P41 vyhraje 20/20 (`difficulty.json`); obtížnost drží slabý
// robot kategorie (`stunt-bot.test.ts`: prohraje ≥ 8 z 10) a špatné rozvržení (`buildshift-bot.test.ts`: prohraje).
// P68 T9: minigolf taky 20/20; drží ho slabý robot `minigolf-bot.test.ts` (dojdou mu údery na ≥ 8 z 10 jamek).
// P68 T12: drawsave taky 20/20 (robot kategorie profil nečte); drží ho čára mimo postavu (`arcade/__tests__/drawsave.test.ts`:
// prohraje ≥ 10 z 12) – profil začátečníka je žádost kategorii v `integration-log.md`.
const OWN_DIFFICULTY: ReadonlySet<string> = new Set(['hole.default', 'steal.default', 'sort.default', 'arrows.default', 'buildshift.default', 'stunt.default', 'minigolf.default', 'drawsave.default']);

it('pins measured novice and intermediate bounds for every current live recipe', () => {
  const report = JSON.parse(readFileSync('evals/play/p41/difficulty.json', 'utf8')) as {
    profiles: typeof BOT_PROFILES;
    seeds: number[];
    cells: string[];
    summary: Array<{ cell: string; specHash: string; profiles: Record<string, {
      runs: number; wins: number; winRate: number; errors: number; replayMismatches: number;
    }> }>;
  };
  const cells = liveCells();
  expect(report.profiles).toEqual(BOT_PROFILES);
  expect(report.seeds).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(report.cells).toEqual(cells.map(cell => cell.id));
  expect(report.summary).toHaveLength(cells.length);
  for (const cell of cells) {
    const row = report.summary.find(row => row.cell === cell.id)!;
    expect(row, cell.id).toBeDefined();
    expect(row.specHash, `${cell.id}: stale measurement`).toBe(
      createHash('sha256').update(JSON.stringify(compileRecipe(assemblyOfCell(cell)))).digest('hex'),
    );
    for (const profile of ['novice', 'intermediate']) {
      const result = row.profiles[profile];
      expect(result.runs, cell.id).toBe(20);
      expect(result.errors, cell.id).toBe(0);
      expect(result.replayMismatches, cell.id).toBe(0);
      expect(result.winRate, cell.id).toBe(result.wins / 20);
      if (profile === 'novice' && OWN_DIFFICULTY.has(cell.id)) continue;
      expect(result.winRate, `${cell.id}/${profile}`).toBeGreaterThanOrEqual(profile === 'novice' ? 0.3 : 0.8);
      // Běžec se střelbou (P46A) je lehčí záměrně: horní mez začátečníka bez něj (rozhodnutí majitele 14. 10., jako `runner-boss.test`).
      // Míč s finále (P51 T4, `evals/play/p51/README.md` „Rozhodnutí“): začátečník se od intermediate liší jen reakcí, pásmo by držely jen hodiny desetiny sekundy nad jeho během – hlídá se dolní mez.
      const easyByChoice = (cell.id.startsWith('runner.') && cell.id.includes('+shoot_at')) || cell.id.startsWith('ball.');
      expect(result.winRate, `${cell.id}/${profile}`).toBeLessThanOrEqual(profile === 'novice' && !easyByChoice ? 0.7 : 1);
    }
  }
});
