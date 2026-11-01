/**
 * Míry a čtení stavu střelnice z očí (P68-F T2). Jádro, robot, kontrola úrovně i scéna čtou tytéž konstanty odsud.
 *
 * **Osa natočení** je absolutní cílový sektor, ne rychlost otáčení: 9 sektorů po 15° (−4..+4 = ±60°). Zmrazená mřížka
 * osy z P68-I (`RAILFPS_AXES`, `genre/p68-contract.ts`) má 33 kroků po 3,75°; sektor `s` je krok `4s`, osa `250 × s`.
 * Střed se posílá osou **1, nikdy 0** – osa 0 je „žádný vstup“ a relace ji nezapíše. Natočení (`yawStep`, celé číslo
 * −16..16 na držáku) jde k cíli o krok za tik, takže otočka o sektor trvá `YAW.turnTicks` tiků a široká otočka stojí
 * čas. Úhly ve stupních existují jen ve scéně.
 *
 * **Paprsky sektorů** jsou celočíselné tabulky sinů a kosinů (× 1000): nepřítel jde po paprsku svého sektoru k hráči,
 * terč na něm stojí. Sektor tělesa z polohy počítá `sectorOf` porovnáním s tangenty hran sektorů – žádná plovoucí čárka
 * v hashovaném stavu.
 */

import { RAILFPS_AXES, RAILFPS_SLOTS, RAILFPS_YAW_STEPS } from '../../genre/p68-contract';
import { ARCADE_HZ, type ArcadeInput, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '../contract';

/** Natočení: 9 sektorů po 15°, krok osy 3,75°, o krok za tik. */
export const YAW = {
  sectors: 9,
  maxSector: 4,
  stepDeg: 15,
  /** Kroků `yawStep` na sektor (16 kroků = 4 sektory = 60°). */
  stepsPerSector: RAILFPS_YAW_STEPS / 4,
  /** Tiků na otočení o jeden sektor: natočení jde o krok za tik. */
  turnTicks: RAILFPS_YAW_STEPS / 4,
} as const;

/**
 * Řádky výšky terčů – střed terče nad zemí v jednotkách. Kamera z očí bez naklánění je ukáže vždy celé: oko je
 * ve výšce prostředního řádku, svislé zorné pole kamery (`railfps-camera.ts`) obsáhne horní i dolní řádek už ve
 * vzdálenosti `RAILFPS.reach`.
 */
export const HEIGHT_ROWS = [700, 1600, 2500] as const;
/** Výška oka hráče: prostřední řádek. */
export const EYE_HEIGHT = HEIGHT_ROWS[1];

export const RAILFPS = {
  /** Dostřel: dál nic nestojí ani nevzniká. */
  range: 30 * UNIT,
  /** Nepřítel, který dojde na tuhle vzdálenost, vezme život a zmizí; tak blízko už zásah neplatí. */
  reach: 4 * UNIT,
  /** Tiků mezi dvěma ranami. */
  fireInterval: 12,
  /** Rychlost nepřítele v kole `k` (jednotek za tik): `enemySpeed + k × enemyRise`; boss `bossSpeedPct` z toho. */
  enemySpeed: 34,
  enemyRise: 6,
  bossSpeedPct: 60,
  bossHp: 6,
  /** Pás vzdálenosti terčů a místa vzniku nepřátel. */
  targetNear: 8 * UNIT,
  targetFar: 16 * UNIT,
  enemyNear: 18 * UNIT,
  enemyFar: 22 * UNIT,
  /** Kdy v kole vyjde první nepřítel a rozestup dalších (tiky hodin kola); s každým kolem o `gapShrink` kratší. */
  firstEnemy: 40,
  gapMin: 70,
  gapMax: 110,
  gapShrink: 8,
  /** Podíl nepřátel ve vlně (procenta, zaokrouhleno nahoru); zbytek jsou terče. */
  enemyPct: 60,
  /** Nejvíc věcí ve vlně (terče + nepřátelé + boss). */
  waveMax: 12,
  /** Věcí ke zničení celkem a vln – meze parametrů hry. */
  targets: { min: 8, max: 36, default: 16 },
  waves: { min: 2, max: 5, default: 3 },
  /** Body za terč, nepřítele a bosse. */
  points: { target: 10, enemy: 15, boss: 60 },
  /** Časový limit celé hry (s): drží každý konec v horizontu ověření, i u hráče, který terče nechá stát. */
  seconds: 85,
  /** Reakce robota (tiky) – kontrola úrovně s ní počítá u každého cíle. */
  botReaction: 8,
  player: { w: 600, h: 1700, d: 600 },
  target: { w: 1000, h: 1000, d: 300 },
  enemy: { w: 900, h: 1800, d: 900 },
  boss: { w: 1600, h: 2800, d: 1600 },
} as const;

/** Indexy těl úrovně: hráč, držák stavu, předlohy terče, nepřítele a bosse. */
export const RAILFPS_BODIES = { player: 0, keeper: 1, target: 2, enemy: 3, boss: 4 } as const;
/** Druh těla držáku (`BODY.kind` → `world.kinds`): scéna ho podle něj najde a nekreslí. */
export const RAILFPS_RIG_KIND = 'railfps_rig';

/**
 * Sloty držáku. `yaw` je zmrazený slot `RAILFPS_SLOTS.yawStep`; ostatní jsou stav této hry: cílový krok, západka
 * spouště (výstřel čeká, než natočení dorazí), odpočet mezi ranami, výstřel v tomto tiku (sektor + 5, 0 = nic),
 * hodiny kola a kolo, ke kterému hodiny patří.
 */
export const RIG = {
  yaw: RAILFPS_SLOTS.yawStep,
  goal: BODY.y,
  latch: BODY.z,
  cooldown: BODY.vx,
  shot: BODY.vy,
  clock: BODY.vz,
  round: BODY.aux0,
} as const;

/** Sloty nepřítele: sektor + 5 (0 = ještě nezařazený, právě vznikl) a vzdálenost po paprsku. */
export const FOE = { sector: BODY.aux0, distance: BODY.aux1 } as const;
const SECTOR_BIAS = 5;

// ---------------------------------------------------------------------------
// Osa

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
/** Zaokrouhlení podílu `num / den` (den > 0) k nejbližšímu, polovina od nuly – stejně pro kladná i záporná. */
const roundDiv = (num: number, den: number): number => Math.sign(num) * Math.floor((Math.abs(num) * 2 + den) / (2 * den));

/** Nejbližší krok mřížky osy (−16..16). */
export const axisToStep = (axis: number): number => clamp(roundDiv(axis * RAILFPS_YAW_STEPS, 1000), -RAILFPS_YAW_STEPS, RAILFPS_YAW_STEPS);

/** Sektor (−4..4), na který osa míří: nejbližší krok, pak nejbližší sektor. */
export const axisToSector = (axis: number): number => clamp(roundDiv(axisToStep(axis), YAW.stepsPerSector), -YAW.maxSector, YAW.maxSector);

/** Osa pro sektor: krok `4s` mřížky `RAILFPS_AXES`, střed osou 1 (0 = žádný vstup). */
export function sectorToAxis(sector: number): number {
  const s = clamp(Math.trunc(sector), -YAW.maxSector, YAW.maxSector);
  return s === 0 ? 1 : (RAILFPS_AXES[s * YAW.stepsPerSector + RAILFPS_YAW_STEPS] as number);
}

export const sectorToStep = (sector: number): number => sector * YAW.stepsPerSector;

// ---------------------------------------------------------------------------
// Paprsky sektorů

/** sin a cos 15° × k pro k = 0..4, × 1000. */
const SIN = [0, 259, 500, 707, 866] as const;
const COS = [1000, 966, 866, 707, 500] as const;
/** tan hran sektorů (7,5°, 22,5°, 37,5°, 52,5°) × 1000. */
const TAN_EDGE = [132, 414, 767, 1303] as const;

const sinOf = (sector: number): number => Math.sign(sector) * (SIN[Math.abs(sector)] as number);
const cosOf = (sector: number): number => COS[Math.abs(sector)] as number;

/** Bod na paprsku sektoru ve vzdálenosti `distance`. */
export const rayPoint = (sector: number, distance: number): { readonly x: number; readonly z: number } => ({
  x: Math.trunc((sinOf(sector) * distance) / 1000),
  z: Math.trunc((cosOf(sector) * distance) / 1000),
});

/** Vzdálenost bodu po paprsku sektoru (průmět). */
export const rayDistance = (sector: number, x: number, z: number): number => Math.trunc((x * sinOf(sector) + z * cosOf(sector)) / 1000);

/** Sektor bodu před hráčem (−4..4); co je za hranou krajního sektoru nebo za zády, patří krajnímu sektoru své strany. */
export function sectorOf(x: number, z: number): number {
  const side = x < 0 ? -1 : 1;
  if (z <= 0) return x === 0 ? 0 : side * YAW.maxSector;
  const ax = Math.abs(x) * 1000;
  let k = 0;
  while (k < TAN_EDGE.length && ax > z * (TAN_EDGE[k] as number)) k += 1;
  return k === 0 ? 0 : side * k;
}

// ---------------------------------------------------------------------------
// Míření (sdílí ovládání i robot)

export interface AimState {
  readonly yaw: number;
  readonly goal: number;
  readonly latch: number;
  readonly cooldown: number;
}

/**
 * Jeden tik míření: osa ≠ 0 nastaví cílový sektor, vlevo/vpravo ho posune o sektor, `FIRE` (i ťuk) natáhne západku;
 * natočení jde o krok k cíli, odpočet ubude a se západkou, natočením v cíli a nulovým odpočtem padne rána do sektoru
 * natočení. Čistá funkce – ovládání a robot počítají totéž.
 */
export function aimTick(aim: AimState, input: ArcadeInput): { readonly next: AimState; readonly shot: number | null } {
  let goal = aim.goal;
  if (input.axis !== 0) goal = sectorToStep(axisToSector(input.axis));
  const span = sectorToStep(YAW.maxSector);
  if ((input.buttons & BUTTON.LEFT) !== 0) goal = clamp(goal - YAW.stepsPerSector, -span, span);
  if ((input.buttons & BUTTON.RIGHT) !== 0) goal = clamp(goal + YAW.stepsPerSector, -span, span);
  const latch = (input.buttons & (BUTTON.FIRE | BUTTON.TAP)) !== 0 ? 1 : aim.latch;
  const yaw = aim.yaw < goal ? aim.yaw + 1 : aim.yaw > goal ? aim.yaw - 1 : aim.yaw;
  const cooldown = Math.max(0, aim.cooldown - 1);
  if (latch === 1 && yaw === goal && cooldown === 0) {
    return { next: { yaw, goal, latch: 0, cooldown: RAILFPS.fireInterval }, shot: roundDiv(yaw, YAW.stepsPerSector) };
  }
  return { next: { yaw, goal, latch, cooldown }, shot: null };
}

// ---------------------------------------------------------------------------
// Čtení stavu

const rig = (keeper: number, slot: number): number => bodyBase(keeper) + slot;

export const aimOf = (state: Int32Array, keeper: number): AimState => ({
  yaw: state[rig(keeper, RIG.yaw)] as number,
  goal: state[rig(keeper, RIG.goal)] as number,
  latch: state[rig(keeper, RIG.latch)] as number,
  cooldown: state[rig(keeper, RIG.cooldown)] as number,
});

export function writeAim(state: Int32Array, keeper: number, aim: AimState, shot: number | null): void {
  state[rig(keeper, RIG.yaw)] = aim.yaw;
  state[rig(keeper, RIG.goal)] = aim.goal;
  state[rig(keeper, RIG.latch)] = aim.latch;
  state[rig(keeper, RIG.cooldown)] = aim.cooldown;
  state[rig(keeper, RIG.shot)] = shot === null ? 0 : shot + SECTOR_BIAS;
}

/** Natočení v krocích (−16..16) – kamera ho jen sleduje. */
export const yawStepOf = (state: Int32Array, keeper: number): number => state[rig(keeper, RIG.yaw)] as number;
/** Sektor, do kterého v tomto tiku padla rána, nebo `null`. */
export function shotOf(state: Int32Array, keeper: number): number | null {
  const code = state[rig(keeper, RIG.shot)] as number;
  return code === 0 ? null : code - SECTOR_BIAS;
}
export const clockOf = (state: Int32Array, keeper: number): number => state[rig(keeper, RIG.clock)] as number;

export const isAlive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const roleOf = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.role] as number;
export const isFoe = (state: Int32Array, body: number): boolean => {
  const role = roleOf(state, body);
  return role === ROLE.target || role === ROLE.enemy;
};
export const isEnemy = (state: Int32Array, body: number): boolean => roleOf(state, body) === ROLE.enemy;
/** Tělo nese model předlohy `template` (boss se pozná podle druhu). */
export const sameKind = (state: Int32Array, body: number, template: number): boolean => state[bodyBase(body) + BODY.kind] === state[bodyBase(template) + BODY.kind];

/** Živé terče a nepřátelé (bez předloh). */
export function foesOf(state: Int32Array): number[] {
  const out: number[] = [];
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) if (isAlive(state, i) && isFoe(state, i)) out.push(i);
  return out;
}

/** Sektor tělesa: nepřítel ho nese od zařazení, jinak z polohy. */
export function foeSector(state: Int32Array, body: number): number {
  const base = bodyBase(body);
  const code = state[base + FOE.sector] as number;
  if (isEnemy(state, body) && code !== 0) return code - SECTOR_BIAS;
  return sectorOf(state[base + BODY.x] as number, state[base + BODY.z] as number);
}

/** Vzdálenost tělesa po paprsku jeho sektoru. */
export function foeDistance(state: Int32Array, body: number): number {
  const base = bodyBase(body);
  if (isEnemy(state, body) && (state[base + FOE.sector] as number) !== 0) return state[base + FOE.distance] as number;
  return rayDistance(foeSector(state, body), state[base + BODY.x] as number, state[base + BODY.z] as number);
}

/**
 * Nepřítel jde o `speed` po paprsku k hráči. Čerstvě vzniklý (sektor 0) se nejdřív zařadí: sektor a vzdálenost
 * z polohy, kam ho postavil příchod.
 */
export function walkEnemy(state: Int32Array, body: number, speed: number): void {
  const base = bodyBase(body);
  if ((state[base + FOE.sector] as number) === 0) {
    const sector = sectorOf(state[base + BODY.x] as number, state[base + BODY.z] as number);
    state[base + FOE.sector] = sector + SECTOR_BIAS;
    state[base + FOE.distance] = rayDistance(sector, state[base + BODY.x] as number, state[base + BODY.z] as number);
  }
  const sector = (state[base + FOE.sector] as number) - SECTOR_BIAS;
  const distance = Math.max(0, (state[base + FOE.distance] as number) - speed);
  const at = rayPoint(sector, distance);
  state[base + FOE.distance] = distance;
  state[base + BODY.x] = at.x;
  state[base + BODY.z] = at.z;
  state[base + BODY.vx] = 0;
  state[base + BODY.vz] = 0;
}

/** Rychlost nepřátel v kole `round`. */
export const enemySpeedAt = (round: number): number => RAILFPS.enemySpeed + round * RAILFPS.enemyRise;
/** Rychlost bosse z rychlosti kola: boss jde pomaleji. */
export const bossSpeedOf = (speed: number): number => Math.trunc((speed * RAILFPS.bossSpeedPct) / 100);

/** Tiky chůze od vzniku ve vzdálenosti `distance` do `reach`. */
export const walkTicks = (distance: number, speed: number): number => Math.ceil(Math.max(0, distance - RAILFPS.reach) / speed);

/** Spodní hrana terče v řádku `row`. */
export const targetY = (row: number): number => (HEIGHT_ROWS[row] as number) - RAILFPS.target.h / 2;

/** Časový limit hry v tikách. */
export const RAILFPS_LIMIT_TICKS = RAILFPS.seconds * ARCADE_HZ;
