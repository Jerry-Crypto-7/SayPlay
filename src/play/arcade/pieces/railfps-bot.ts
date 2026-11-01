/**
 * Robot střelnice z očí (P68-F T3) pod jménem kostry `railfps_bot`, a slabý hráč, který musí prohrát.
 *
 * Robot vidí svět `reactionTicks` starý. Natočení, západku a odpočet „teď“ si dopočítá z vlastních stisků od té doby
 * (`aimTick` – tatáž čistá funkce, kterou míří ovládání), stejně jako rány, které mezitím padly: každá srazí nejbližší
 * cíl v sektoru (`foesInSector`, totéž pravidlo jako jádro), boss si odečte HP. Ze zbylých cílů vybere nejvíc ohrožující –
 * nepřítele, který dojde nejdřív; terče nikam nejdou, mezi nimi rozhodne nejmenší otočka – a pošle
 * `press(FIRE, sectorToAxis(s))`. Mačká jen tehdy, když rána do toho sektoru ještě není natažená, takže záznam
 * zůstane řídký (jeden stisk na ránu). Deterministický: rozhoduje jen ze stavu a vlastních stisků.
 */

import { z } from 'zod';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, type ArcadeWorld, type BotPiece, BUTTON, type InputEvent, NO_INPUT, bodyHp, nativeRule } from '../contract';
import { inBreak, roundOf } from '../hooks';
import { RAILFPS, YAW, aimOf, aimTick, bossSpeedOf, enemySpeedAt, foeDistance, foeSector, foesInSector, foesOf, isEnemy, sameKind, sectorToAxis, sectorToStep, walkTicks } from './railfps';

const template = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

/** Parametry vydá generátor `railfps_rail`: držák míření, počítadlo háčků (kolo, přestávka) a předloha bosse. */
const botParams = z.object({ keeper: template, hooks: template, boss: template }).strict();
export type RailfpsBotParams = z.infer<typeof botParams>;

/** Tiky, než nepřítel dojde k hráči; terč nejde nikam. */
function etaOf(state: Int32Array, body: number, params: RailfpsBotParams): number {
  if (!isEnemy(state, body)) return Number.MAX_SAFE_INTEGER;
  const speed = enemySpeedAt(roundOf(state, params.hooks));
  return walkTicks(foeDistance(state, body), sameKind(state, body, params.boss) ? bossSpeedOf(speed) : speed);
}

export const railfpsBot: BotPiece<RailfpsBotParams> = {
  id: 'railfps_bot',
  params: botParams,
  roles: ['player', 'target', 'enemy'],
  reactionTicks: RAILFPS.botReaction,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, recent }, params): ArcadeInput => {
    // V přestávce svět stojí a vstup nečte.
    if (inBreak(state, params.hooks)) return NO_INPUT;
    // Míření „teď“ a rány od pozorovaného stavu: kolik ran který cíl už dostal.
    let aim = aimOf(state, params.keeper);
    const taken = new Map<number, number>();
    const shotsLeft = (body: number): number => Math.max(1, bodyHp(state, body)) - (taken.get(body) ?? 0);
    for (const input of recent) {
      const { next, shot } = aimTick(aim, input);
      aim = next;
      if (shot === null) continue;
      const struck = foesInSector(state, shot).find((body) => shotsLeft(body) > 0);
      if (struck !== undefined) taken.set(struck, (taken.get(struck) ?? 0) + 1);
    }
    const from = Math.round(aim.goal / YAW.stepsPerSector);
    const pick = foesOf(state)
      .filter((body) => shotsLeft(body) > 0)
      .map((body) => ({ body, sector: foeSector(state, body), eta: etaOf(state, body, params) }))
      .sort((a, b) => a.eta - b.eta || Math.abs(a.sector - from) - Math.abs(b.sector - from) || a.body - b.body)[0];
    if (pick === undefined) return NO_INPUT;
    if (aim.latch === 1 && aim.goal === sectorToStep(pick.sector)) return NO_INPUT;
    return { buttons: BUTTON.FIRE, axis: sectorToAxis(pick.sector) };
  },
};

/** Slabý hráč: kouká jen dopředu (střed a sousední sektory) a střílí s pevným zpožděním, ať je co trefit, nebo ne. */
export const RAILFPS_WEAK = { first: 30, every: 30, sectors: [0, 1, 0, -1] } as const;

/**
 * Záznam slabého hráče na celou hru (do časového limitu světa, nejdéle horizont ověření): každých `every` tiků
 * ťuk do dalšího sektoru z `sectors`. Cíle za krajem středového výseku nikdy nesrazí, takže vlna se nevyčistí
 * a nepřátelé z boků dojdou – musí prohrát.
 */
export function railfpsWeakInputs(world: ArcadeWorld): InputEvent[] {
  const seconds = nativeRule(world.rules, 'time_limit')?.params.seconds;
  const horizon = typeof seconds === 'number' ? Math.min(ARCADE_LIMITS.maxTicks, seconds * ARCADE_HZ) : ARCADE_LIMITS.maxTicks;
  const out: InputEvent[] = [];
  for (let tick = RAILFPS_WEAK.first, n = 0; tick < horizon; tick += RAILFPS_WEAK.every, n += 1) {
    out.push({ tick, buttons: BUTTON.FIRE, axis: sectorToAxis(RAILFPS_WEAK.sectors[n % RAILFPS_WEAK.sectors.length] as number) });
  }
  return out;
}
