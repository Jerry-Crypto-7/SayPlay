/**
 * Hvězdy běhu (P36B T1): 0–3 z výsledku proti „paru“ – běhu robota
 * ověřovače téže hry (`runBot`, uložený při publikaci jako `report.par`).
 *
 * Hvězdy jsou relativní k paru, ne k absolutním číslům, takže změna vzorce
 * skóre v jádře (P36A) je nerozbije – par se spočítá týmž vzorcem. Leží mimo
 * hashovaný stav: čtou se jen čísla skončeného běhu.
 */

/** Konec běhu, jak ho vidí výsledek: životy jsou čítač `health`, `livesStart` jeho hodnota v tiku 0. */
export interface RunResult {
  readonly won: boolean;
  readonly score: number;
  readonly ticks: number;
  readonly lives: number;
  readonly livesStart: number;
}

/** Vítězný běh robota ověřovače téže hry. */
export interface Par {
  readonly score: number;
  readonly ticks: number;
}

export type Stars = 0 | 1 | 2 | 3;

interface Tier {
  /** Nejvýš tolikanásobek tiků paru. */
  readonly time: number;
  /** Aspoň tolikanásobek skóre paru (jen hra, kde par boduje). */
  readonly score: number;
  /** Aspoň takový podíl životů z tiku 0 (jen hra se životy). */
  readonly lives: number;
}

/**
 * Prahy. Robot hraje cíl optimálně, jen s reakčním zpožděním, ale skóre
 * nehoní – člověk ho přebít může, času robota se na telefonu skoro nedotkne.
 *
 * - **3 hvězdy** = běh jako robot: do 1,25× jeho času (čtvrtina rezervy na
 *   přečtení scény a prst na skle), aspoň jeho skóre a bez ztraceného života.
 * - **2 hvězdy** = dobrý lidský běh: do dvojnásobku času, aspoň polovina skóre
 *   a aspoň polovina životů.
 * - **1 hvězda** = výhra. Prohra je vždy 0.
 *
 * Každé kritérium musí projít samo – skóre nad parem nevyváží pomalý běh.
 * Hra na přežití (`survive_time`) končí pro oba v témž tiku, takže čas tam
 * projde vždy a rozhodují životy a skóre.
 */
export const STARS: { readonly three: Tier; readonly two: Tier } = {
  three: { time: 1.25, score: 1, lives: 1 },
  two: { time: 2, score: 0.5, lives: 0.5 },
};

function meets(run: RunResult, par: Par, tier: Tier): boolean {
  if (run.ticks > par.ticks * tier.time) return false;
  // Hra, kde robot nic nenabodoval, skóre nesoudí.
  if (par.score > 0 && run.score < par.score * tier.score) return false;
  if (run.livesStart > 0 && run.lives < run.livesStart * tier.lives) return false;
  return true;
}

/** `par` chybí (hra publikovaná před P36B) → výhra je 1 hvězda. */
export function starsFor(run: RunResult, par: Par | null): Stars {
  if (!run.won) return 0;
  if (par === null) return 1;
  if (meets(run, par, STARS.three)) return 3;
  if (meets(run, par, STARS.two)) return 2;
  return 1;
}
