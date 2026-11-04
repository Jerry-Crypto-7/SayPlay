/**
 * P70B T5: the verdict on the sealed set, computed from the raw rows only – used by `holdout.measure.mjs report`
 * and by `__tests__/result.test.ts`, which recomputes `result.json` from the same files.
 */

/** Cíle z plánu P70B T5 (AC2). */
export const GOALS = { heroPct: 90, golfMinigolf: 18, g2Pct: 95 };

/** Správně poslaná věta: golf dojde do minigolfu, ostatní do žánru ze štítku `acceptable`. */
export const routedRight = (row) => (row.half === 'golf' ? row.game === 'minigolf' : row.acceptable.includes(row.game));

/** Počty jedné strany (`rows` z `route-*.json`). Obecná věta se štítkem `none` se do chyb nepočítá (jako P68). */
export function sideOf(rows) {
  const animals = rows.filter((row) => row.half === 'animal');
  const golf = rows.filter((row) => row.half === 'golf');
  const counted = rows.filter((row) => row.half === 'general' && row.best !== 'none');
  return {
    animals: animals.length,
    heroRight: animals.filter((row) => row.heroModels.includes(row.hero)).length,
    golf: golf.length,
    golfMinigolf: golf.filter((row) => row.game === 'minigolf').length,
    generalCounted: counted.length,
    generalWrong: counted.filter((row) => !row.acceptable.includes(row.game)).length,
    routedRight: rows.filter(routedRight).length,
  };
}

/** Hratelná věta brány G2: přeložila se, robot vyhraje, nečinný i slabý prohraje a požadované akce proběhnou. */
const playable = (result) => result.failed === null && result.win && result.lose && result.actions;

export function verdictOf(main, branch, gameplay) {
  const before = sideOf(main.rows);
  const after = sideOf(branch.rows);
  const byId = new Map(main.rows.map((row) => [row.id, row]));
  const g2 = { n: gameplay.results.length, pass: gameplay.results.filter(playable).length, failed: gameplay.results.filter((result) => !playable(result)).map((result) => result.sentence) };
  return {
    main: before,
    branch: after,
    // Obecné věty, které změnily hru mezi stranami (informace k „beze zhoršení“).
    generalMoves: branch.rows.filter((row) => row.half === 'general' && byId.get(row.id)?.game !== row.game).map((row) => ({ id: row.id, from: byId.get(row.id)?.game ?? null, to: row.game, acceptable: row.acceptable.includes(row.game) })),
    g2,
    goals: {
      hero: { value: after.heroRight, of: after.animals, main: before.heroRight, met: after.heroRight * 100 >= GOALS.heroPct * after.animals },
      golf: { value: after.golfMinigolf, of: after.golf, main: before.golfMinigolf, met: after.golfMinigolf >= GOALS.golfMinigolf },
      general: { value: after.generalWrong, of: after.generalCounted, main: before.generalWrong, met: after.generalWrong <= before.generalWrong },
      g2: { value: g2.pass, of: g2.n, met: g2.pass * 100 >= GOALS.g2Pct * g2.n },
    },
  };
}
