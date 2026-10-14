/**
 * Plošinovka (P25C, T2): ovládání, generátor úrovně a pravidla.
 *
 * Boční pohled: úroveň běží po +z (vpravo), `x` je hloubka a zůstává 0.
 * Vlevo/vpravo (osa nebo tlačítka) = zrychlení a tření, ťuk/nahoru = skok
 * ze země, volitelně jeden dvojskok ve vzduchu. Generátor staví řadu plošin
 * nad propastí a zná konstanty ovládání, takže úroveň je **hratelná
 * z konstrukce**: každá mezera je v dosahu jednoho skoku i se zpožděním
 * reakce, výškový rozdíl jde vyskočit a hrot má před sebou i za sebou místo
 * na rozběh a dopad. `checkPlatformLevel` to samé tvrzení přepočítá nad
 * hotovou úrovní – test i ověření ho čtou.
 *
 * Se `sections: 3` (P36A T4, žánr Skákačka) je úroveň ze tří úseků s rostoucí
 * obtížností a checkpointy, délkou podle obsahu a hodinami (`PLATFORM_SECTIONS`).
 *
 * Pocit skoku `feel: 2` (P32F T2) odpouští: skok ještě 100 ms po sběhnutí
 * z hrany (coyote time), stisk až 120 ms před dopadem skočí při dopadu
 * (buffer) a držení po odrazu skok prodlouží. Ťuk skočí přesně jako dřív,
 * takže dosah, ze kterého generátor počítá mezery, platí dál – i pro vstup,
 * který držení neposílá.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, type ArcadeLevel, AXIS_MAX, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, HIT_GRACE, type PieceRef, UNIT, bodyBase } from '../contract';
import { GRAVITY } from '../kernel';

export const PLATFORM_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PlatformDifficulty = (typeof PLATFORM_DIFFICULTIES)[number];

export const PLATFORM = {
  /** Nejvyšší rychlost do strany (6,6 m/s). */
  maxRun: 110,
  groundAccel: 12,
  airAccel: 8,
  groundFriction: 14,
  airDrag: 3,
  jumpVy: 180,
  doubleJumpVy: 160,
  playerW: 600,
  playerH: 1600,
  playerD: 500,
  /** Tloušťka a hloubka desky plošiny. */
  slabH: 800,
  slabW: 3000,
  /** Horní hrana startovní plošiny; ostatní se od ní liší o nejvýš `maxRise` na krok. */
  baseTop: 4000,
  minTop: 2500,
  maxTop: 6500,
  maxRise: 1000,
  /** Spodní stěna hráče pod touhle výškou = spadl do propasti. */
  fallBelowY: 1000,
  spikeH: 500,
  spikeD: 800,
  /** Volno před hrotem i za ním (rozběh a dopad). */
  spikeMargin: 1800,
  /** Kolik z dosahu skoku smí mezera využít – zbytek je rezerva na pozdní odraz. */
  jumpSafety: 0.65,
} as const;

/** Výška spodní stěny po `k` ticích skoku z rovné země (jádro: nejdřív `vy −= g`, pak `y += vy`). */
const jumpY = (k: number): number => PLATFORM.jumpVy * k - (GRAVITY * k * (k + 1)) / 2;

/** Nejvýš dosažená výška skoku. */
export const PLATFORM_JUMP_PEAK = (() => {
  let peak = 0;
  for (let k = 1; jumpY(k) > peak; k += 1) peak = jumpY(k);
  return peak;
})();

/** Poslední tik skoku, kdy je hráč ještě aspoň ve výšce `dh` (na sestupu). */
function airTicks(dh: number): number {
  let last = 0;
  for (let k = 1; k < 200; k += 1) if (jumpY(k) >= dh) last = k;
  return last;
}

/** První tik skoku, kdy hráč dosáhne výšky `dh` (na výstupu). */
export function riseTicks(dh: number): number {
  for (let k = 1; k < 200; k += 1) if (jumpY(k) >= dh) return k;
  return Number.POSITIVE_INFINITY;
}

/**
 * Nejširší mezera (hrana–hrana), kterou úroveň smí mít při výškovém rozdílu
 * `dh` (nahoru kladně): podíl dosahu jednoho skoku plnou rychlostí plus půl
 * hráče, o kterou smí přečnívat hranu při odrazu.
 */
export function maxGap(dh: number): number {
  return Math.floor(PLATFORM.jumpSafety * PLATFORM.maxRun * airTicks(dh)) + PLATFORM.playerD / 2;
}

/**
 * Dosah ťuku plnou rychlostí hrana–hrana při výškovém rozdílu `dh`: střed
 * hráče letí `airTicks` tiků a na obou hranách smí přečnívat o půl hráče.
 * `maxGap` z něj bere nejvýš dvě třetiny, rezerva je tedy víc než 20 %.
 */
export const jumpReach = (dh: number): number => PLATFORM.maxRun * airTicks(dh) + PLATFORM.playerD;

/** Pocit skoku `feel: 2` v ticích (60 Hz): coyote 100 ms, buffer 120 ms, prodloužení skoku držením. */
export const PLATFORM_FEEL = {
  coyoteTicks: 6,
  bufferTicks: 7,
  /** Tolik tiků po odrazu držení ubírá gravitaci o `lift` za tik. */
  liftTicks: 12,
  lift: 4,
} as const;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/**
 * `speed` = nejvyšší rychlost běhu za tik (P46B T6): fáze průběhu (`phase_control`) ji škálují podle úseku
 * a robot ji dostane taky. Bez ní `PLATFORM.maxRun` – uložená úroveň jezdí jako dřív.
 */
const controlParams = z.object({ doubleJump: z.boolean().default(false), feel: z.literal(2).optional(), speed: z.int().min(1).max(2 * PLATFORM.maxRun).optional() }).strict();

const JUMP = BUTTON.TAP | BUTTON.UP;

/**
 * Skok s pocitem `feel: 2`. V `aux1` hráče (jinak ho plošinovka nepoužívá)
 * tři čítače: bity 0–2 zbývající coyote tiky, 3–6 zbývající tiky bufferu
 * (stisk platí v tiku stisku a dalších `bufferTicks`), 7–10 zbývající tiky
 * prodloužení. `aux0` je dál příznak spotřebovaného dvojskoku.
 */
function feelJump(state: Int32Array, base: number, grounded: boolean, input: ArcadeInput, doubleJump: boolean): void {
  const packed = state[base + BODY.aux1] as number;
  let coyote = grounded ? PLATFORM_FEEL.coyoteTicks : packed & 0x7;
  let buffer = (packed >> 3) & 0xf;
  let lift = (packed >> 7) & 0xf;
  const pressed = (input.buttons & JUMP) !== 0;
  if (pressed) buffer = PLATFORM_FEEL.bufferTicks + 1;

  if (buffer > 0 && (grounded || coyote > 0)) {
    state[base + BODY.vy] = PLATFORM.jumpVy;
    coyote = 0;
    buffer = 0;
    lift = PLATFORM_FEEL.liftTicks;
  } else if (pressed && !grounded && doubleJump && state[base + BODY.aux0] === 0) {
    state[base + BODY.vy] = PLATFORM.doubleJumpVy;
    state[base + BODY.aux0] = 1;
    buffer = 0;
    lift = PLATFORM_FEEL.liftTicks;
  } else if (lift > 0 && (input.buttons & BUTTON.HOLD) !== 0 && (state[base + BODY.vy] as number) > 0) {
    state[base + BODY.vy] = (state[base + BODY.vy] as number) + PLATFORM_FEEL.lift;
    lift -= 1;
  } else lift = 0;

  if (buffer > 0) buffer -= 1;
  if (!grounded && coyote > 0) coyote -= 1;
  state[base + BODY.aux1] = coyote | (buffer << 3) | (lift << 7);
}

/** Ovládání plošinovky. `aux0` = 1, když je dvojskok v tomhle letu spotřebovaný. */
export const platformControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'platform',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const grounded = ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0;
    const run = params.speed ?? PLATFORM.maxRun;
    let target = Math.trunc((Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis)) * run) / AXIS_MAX);
    if ((input.buttons & BUTTON.LEFT) !== 0) target = -run;
    if ((input.buttons & BUTTON.RIGHT) !== 0) target = run;
    const vz = state[base + BODY.vz] as number;
    const rate = target !== 0 ? (grounded ? PLATFORM.groundAccel : PLATFORM.airAccel) : grounded ? PLATFORM.groundFriction : PLATFORM.airDrag;
    state[base + BODY.vz] = toward(vz, target, rate);
    state[base + BODY.vx] = 0;

    if (grounded) state[base + BODY.aux0] = 0;
    if (params.feel === 2) {
      feelJump(state, base, grounded, input, params.doubleJump);
      return;
    }
    if ((input.buttons & JUMP) !== 0) {
      if (grounded) state[base + BODY.vy] = PLATFORM.jumpVy;
      else if (params.doubleJump && state[base + BODY.aux0] === 0) {
        state[base + BODY.vy] = PLATFORM.doubleJumpVy;
        state[base + BODY.aux0] = 1;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly gap: readonly [number, number];
  readonly rise: number;
  readonly slab: readonly [number, number];
  /** Hrot na každé n-té plošině. */
  readonly spikeEvery: number;
}

const TIERS: Readonly<Record<PlatformDifficulty, Tier>> = {
  easy: { gap: [1500, 2000], rise: 400, slab: [5000, 8000], spikeEvery: 4 },
  normal: { gap: [1600, 2600], rise: 700, slab: [4500, 7000], spikeEvery: 2 },
  hard: { gap: [2000, 3400], rise: PLATFORM.maxRise, slab: [4500, 6500], spikeEvery: 1 },
};

export const PLATFORM_LEVEL = {
  minLengthM: 60,
  /** Robot na „hard“ dojde 250 m za ~75 s; delší úroveň se do 90 s nevejde. */
  maxLengthM: 250,
  /** Čekání na pohyblivé plošiny stojí čas: s nimi nejvýš 180 m. */
  maxMovingLengthM: 180,
  startSlab: 8000,
  finalSlab: 6000,
  /** Mezera s pohyblivou plošinou a její deska. */
  shuttleGap: [7000, 9000] as const,
  shuttleSlab: 2500,
  shuttleSpeed: 30,
  /** Nejmenší mezera mezi pohyblivou plošinou a hranou v krajní poloze. */
  shuttleClear: 250,
  maxCoins: 60,
  /** Kolik věcí sebrat, když věta počet neřekne (P35 T3), a nejvýš kolik – tolik míst na zemi má i nejkratší úroveň. */
  collectCount: 5,
  maxCollect: 8,
} as const;

const generatorParams = z
  .object({
    difficulty: z.enum(PLATFORM_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(PLATFORM_LEVEL.minLengthM).max(PLATFORM_LEVEL.maxLengthM).default(120),
    movingPlatforms: z.boolean().default(false),
    checkpoints: z.boolean().default(false),
    coins: z.boolean().default(true),
    doubleJump: z.boolean().default(false),
    /** Přesný počet mincí z počtu rolí (P26D T9); bez hodnoty co místo dá. */
    coinCount: z.int().min(1).max(PLATFORM_LEVEL.maxCoins).optional(),
    /**
     * Výhra až po sebrání všech věcí (P35 T3, „collect carrots“): `coinCount` věcí
     * jen tam, kudy se po zemi běží, a cíl bez nich nevyhraje (`finish` s `allItems`).
     */
    collectAll: z.boolean().optional(),
    /** Nový pocit skoku (P32-0 T4 šev, naplní P32F T2); přijde z `controlParams.tuning`. Bez něj úroveň beze změny. */
    feel: z.literal(2).optional(),
    /**
     * Úroveň ze tří úseků s rostoucí obtížností, délka podle obsahu a časový limit
     * (P36A T4, `PLATFORM_SECTIONS`); žánr Skákačka ho píše do `tuning`. Bez něj úroveň jako dřív.
     */
    sections: z.literal(3).optional(),
    /**
     * Úroveň z úseků průběhu (P46B T6, `PLATFORM_SEGMENTS`): rozjezd, úsek 2 s pastí a pohyblivou plošinou,
     * úsek 3 a na konci aréna bosse. Značka nové hry – žánr Skákačka ji píše do `tuning`; jen s ní dostane
     * úroveň průběh (`GENRE_PACING.platform_level`), uložená hra bez ní staví tentýž svět. Jen se `sections`.
     */
    segments: z.literal(true).optional(),
  })
  .strict();
export type PlatformLevelParams = z.infer<typeof generatorParams>;

/**
 * Úroveň z úseků (P36A T4). Každý úsek je o stupeň obtížnosti těžší
 * (`PLATFORM_DIFFICULTIES` od `difficulty` − 1 po `difficulty` + 1: širší mezery,
 * vyšší schody, hustší hroty), druhý a třetí začínají checkpointem na plošině bez
 * hrotu a ve třetím (s `movingPlatforms` i ve druhém) jezdí pohyblivá plošina.
 *
 * Délka podle obsahu: plošin náhodně z `platforms` podle semínka věty, věc ke
 * sběru nad výchozí počet přidá `perItem` plošin (pod ním ubere). Pak se úroveň
 * natáhne nebo zkrátí po plošinách, aby ji robot podle odhadu (`platformPaceTicks`)
 * doběhl za `minTicks`..`maxTicks` a byla aspoň `lengthM` dlouhá.
 *
 * Nečinný hráč na startu nic neriskuje, proto má úroveň hodiny
 * (`platformSeconds`): odhad robota × `limitPct` + `limitSlackS`, nejvýš `maxLimitS`.
 */
export const PLATFORM_SECTIONS = {
  /** Plošin za startovní, když věta věci nepočítá: náhodně z rozsahu. */
  platforms: [16, 22],
  /** Plošin navíc za každou věc ke sběru nad `PLATFORM_LEVEL.collectCount`. */
  perItem: 2,
  maxPlatforms: 40,
  /** Podíl plošin v úsecích, procenta. */
  share: [30, 33, 37],
  /**
   * Tempo robota v procentech běhu plnou rychlostí (`PLATFORM.maxRun`) podle obtížnosti úseku –
   * sonda 20 semínek × 120–250 m (2. 10. 2026): easy 148–154 %, normal 158–167 %, hard 171–184 %.
   */
  pace: { easy: 155, normal: 167, hard: 184 } satisfies Readonly<Record<PlatformDifficulty, number>>,
  /**
   * Robot podle odhadu doběhne nejdřív za 36 s a nejpozději za 62 s; hodiny pak nejvýš 88 s.
   * Skutečný čas robota je 0,86–1,15 × odhad (sonda 30 semínek × 3 obtížnosti × 5 variant).
   */
  minTicks: 36 * ARCADE_HZ,
  maxTicks: 62 * ARCADE_HZ,
  limitPct: 160,
  limitSlackS: 10,
  /** Pod horizontem jádra (90 s): nečinný hráč prohraje dřív, než ověření skončí. */
  maxLimitS: 88,
} as const;

/**
 * Úroveň z úseků průběhu (P46B T6, `segments`): části podle úseků `PACING.segments` (rozjezd 0–200 ‰,
 * úsek 2 200–650, úsek 3 650–850, finále 850–1000), ne po třetinách.
 * - Rozjezd o stupeň lehčí než `difficulty`, úsek 2 a 3 v ní – úsek 3 přidá jen rychlost (fáze průběhu).
 * - Úsek 2 od `trapFrom` ‰ přinese past (hrot, který vyjíždí ze země a zajíždí, `piston`) a pohyblivou
 *   plošinu: obojí až za 40 m zorného pole měřidla T1 od konce rozjezdu, takže je hráč poprvé vidí v úseku 2.
 * - Konec je aréna bosse `arena` (R5): schod a římsa o `pit` nad dnem jámy, za římsou jáma s cílem na konci. Boss
 *   je dvakrát vyšší než hrdina, ze dna ani ze schodu mu na hlavu nikdo nedoskočí – jen z římsy (checkpoint).
 *   Aréna je dlouhá jako dřív rovná deska, takže úroveň i hranice úseků v ‰ zůstaly, kde byly.
 * `share` = podíl plošin bez arény v rozjezdu, úseku 2 a úseku 3; `shuttleAt` = kde v úseku 2 (podíl jeho plošin)
 * jezdí pohyblivá plošina. `bossTicks` = co boss přidá k odhadu robota (hodiny úrovně).
 */
export const PLATFORM_SEGMENTS = {
  share: [24, 52, 24],
  shuttleAt: 0.7,
  trapFrom: 450,
  trapUntil: 650,
  /** Dno jámy pod římsou; schod je v půlce. Oba kroky nahoru ≤ `PLATFORM.maxRise`. */
  pit: 1800,
  /** Mezera mezi schodem a římsou, délka schodu a římsy; jáma začíná hned za římsou a vyplní zbytek arény. */
  stairs: { gap: 1500, step: 2500, ledge: 4000 },
  arena: 20 * UNIT,
  /** Checkpoint i na každé tolikáté plošině úseku 2 a 3 (lichá – bez hrotu). */
  checkpointEvery: 4,
  /** Mezera s pohyblivou plošinou: kratší než bez průběhu – cyklus plošiny 2,8–3,9 s, čekání na ni není mrtvý čas. */
  shuttleGap: [5500, 6500] as const,
  /** Past: hrot vyjede nejvýš `PLATFORM.spikeH` nad desku, polovinu cyklu je celý v ní; rychlost za tik. */
  piston: { speed: 25, hidden: PLATFORM.spikeH },
  bossTicks: 12 * ARCADE_HZ,
} as const;

/** Past úseku 2: hrot kyvadlem nahoru a dolů – nejníž `hidden` pod deskou, nejvýš `spikeH` nad ní. */
const pistonBody = (z: number, top: number): BodyInit => {
  const travel = PLATFORM_SEGMENTS.piston.hidden + PLATFORM.spikeH;
  return { ...spikeBody(z, top - PLATFORM.spikeH - PLATFORM_SEGMENTS.piston.hidden), kinematic: true, vy: PLATFORM_SEGMENTS.piston.speed, period: Math.floor(travel / PLATFORM_SEGMENTS.piston.speed) };
};

const slab = (near: number, far: number, top: number): BodyInit => ({
  role: 'platform',
  kind: 'platform',
  x: 0,
  y: top - PLATFORM.slabH,
  z: (near + far) / 2,
  w: PLATFORM.slabW,
  h: PLATFORM.slabH,
  d: far - near,
  solid: true,
});

const coin = (z: number, y: number): BodyInit => ({ role: 'collectible', kind: 'coin', x: 0, y, z, w: 500, h: 500, d: 500, solid: false });

const playerBody = (): BodyInit => ({ role: 'player', kind: 'player', x: 0, y: PLATFORM.baseTop, z: 0, w: PLATFORM.playerW, h: PLATFORM.playerH, d: PLATFORM.playerD, solid: false });

const spikeBody = (z: number, top: number): BodyInit => ({ role: 'hazard', kind: 'spikes', x: 0, y: top, z, w: 1200, h: PLATFORM.spikeH, d: PLATFORM.spikeD, solid: false });

const checkpointBody = (z: number, top: number): BodyInit => ({ role: 'checkpoint', kind: 'checkpoint', x: 0, y: top, z, w: 400, h: 2000, d: 400, solid: false });

/** Pohyblivá plošina kyvadlem mezi hranami mezery `gap` za hranou `far`. */
function shuttleBody(far: number, gap: number, top: number): BodyInit {
  const half = PLATFORM_LEVEL.shuttleSlab / 2;
  const from = far + PLATFORM_LEVEL.shuttleClear + half;
  const period = Math.floor((gap - 2 * PLATFORM_LEVEL.shuttleClear - PLATFORM_LEVEL.shuttleSlab) / PLATFORM_LEVEL.shuttleSpeed);
  return { ...slab(from - half, from + half, top), kind: 'platform-moving', kinematic: true, vz: PLATFORM_LEVEL.shuttleSpeed, period };
}

/** Věci ke sběru na hotové úrovni: se sbíráním všeho jen na zemi rozložené po trati, jinak co místo dá. */
function placeCoins(bodies: BodyInit[], params: PlatformLevelParams, spots: { readonly coinSpots: readonly Spot[]; readonly runMids: readonly Spot[]; readonly runSides: readonly Spot[] }): void {
  if (params.collectAll === true) {
    // Mince nad hrotem robot mine, když skočí jinde – musí se sebrat všechno, takže jen zem, rozložená po trati.
    const want = Math.min(params.coinCount ?? PLATFORM_LEVEL.collectCount, ARCADE_LIMITS.maxBodies - bodies.length - 1);
    const pool = spots.runMids.length >= want ? spots.runMids : [...spots.runMids, ...spots.runSides].sort((a, b) => a.z - b.z);
    const take = Math.min(want, pool.length);
    for (let i = 0; i < take; i += 1) {
      const spot = pool[Math.floor(((i + 0.5) * pool.length) / take)]!;
      bodies.push(coin(spot.z, spot.y));
    }
  } else if (params.coins) {
    const budget = Math.min(params.coinCount ?? PLATFORM_LEVEL.maxCoins, ARCADE_LIMITS.maxBodies - bodies.length - 1);
    // S úseky průběhu (P46B T6) rozložené po celé trati: první místa by rozpočet vyčerpala dřív, než hra dojde k pasti a aréně.
    const take = Math.max(0, Math.min(budget, spots.coinSpots.length));
    const picked = params.segments === true ? Array.from({ length: take }, (_, i) => spots.coinSpots[Math.floor(((i + 0.5) * spots.coinSpots.length) / take)] as Spot) : spots.coinSpots.slice(0, take);
    for (const spot of picked) bodies.push(coin(spot.z, spot.y));
  }
}

interface Spot {
  readonly z: number;
  readonly y: number;
}

/** Obtížnost úseku `section` (0–2): o stupeň pod `difficulty`, ona, o stupeň nad ní – v mezích. */
const sectionDifficulty = (difficulty: PlatformDifficulty, section: number): PlatformDifficulty =>
  PLATFORM_DIFFICULTIES[Math.max(0, Math.min(PLATFORM_DIFFICULTIES.length - 1, PLATFORM_DIFFICULTIES.indexOf(difficulty) + section - 1))] as PlatformDifficulty;

/**
 * Odhad, za kolik tiků úroveň z úseků doběhne robot: dráha každého úseku plnou
 * rychlostí × tempo jeho obtížnosti (`PLATFORM_SECTIONS.pace`) a na každé
 * pohyblivé plošině jedna perioda čekání.
 */
export function platformPaceTicks(level: ArcadeLevel, difficulty: PlatformDifficulty, segments = false): number {
  const bounds = [0, ...(level.sectionStarts ?? []), level.length];
  let ticks = 0;
  for (let section = 0; section + 1 < bounds.length; section += 1) {
    const span = (bounds[section + 1] as number) - (bounds[section] as number);
    ticks += (span * PLATFORM_SECTIONS.pace[segments ? sectionDifficulty(difficulty, Math.min(1, section)) : sectionDifficulty(difficulty, section)]) / (100 * PLATFORM.maxRun);
  }
  // Čekání na pohyblivou plošinu; past (kinematický hrot) se jen přeskočí.
  for (const body of level.bodies) if (body.kinematic === true && body.role === 'platform') ticks += body.period ?? 0;
  return Math.ceil(ticks + (segments ? PLATFORM_SEGMENTS.bossTicks : 0));
}

/** Hodiny úrovně z úseků v sekundách: odhad robota × `limitPct` + `limitSlackS`, nejvýš `maxLimitS`. */
export const platformSeconds = (level: ArcadeLevel, difficulty: PlatformDifficulty, segments = false): number =>
  Math.min(PLATFORM_SECTIONS.maxLimitS, Math.ceil((platformPaceTicks(level, difficulty, segments) * PLATFORM_SECTIONS.limitPct) / 100 / ARCADE_HZ) + PLATFORM_SECTIONS.limitSlackS);

/** Plošin v úsecích podle podílů `share`, v každém aspoň jedna. */
function sectionPlatforms(count: number, share: readonly number[]): readonly [number, number, number] {
  const [first, second] = share.map((pct) => Math.max(1, Math.round((count * pct) / 100))) as [number, number];
  return [first, second, Math.max(1, count - first - second)];
}

/** Úroveň z úseků s `extra` plošinami navíc (záporné = méně) proti obsahu věty. */
function sectionedLayout(seed: number, params: PlatformLevelParams, extra: number): { readonly level: ArcadeLevel; readonly platforms: number } {
  const rng = createCompileRng(seed);
  // Los plošin jde vždy první: proud je stejný s počtem z věty i bez něj.
  const drawn = rng.int(PLATFORM_SECTIONS.platforms[0], PLATFORM_SECTIONS.platforms[1]);
  const items = params.collectAll === true ? (params.coinCount ?? PLATFORM_LEVEL.collectCount) - PLATFORM_LEVEL.collectCount : 0;
  const platforms = Math.max(3, Math.min(PLATFORM_SECTIONS.maxPlatforms, drawn + PLATFORM_SECTIONS.perItem * items + extra));
  const { startSlab, finalSlab } = PLATFORM_LEVEL;
  // Úseky průběhu (P46B T6): úsek 3 v obtížnosti úseku 2 (přidá rychlost), pohyblivá plošina v úseku 2, na konci aréna.
  const paced = params.segments === true;

  const slabs: BodyInit[] = [slab(-2000, startSlab - 2000, PLATFORM.baseTop)];
  const extras: BodyInit[] = [];
  const spots = { coinSpots: [] as Spot[], runMids: [] as Spot[], runSides: [] as Spot[] };
  const starts: number[] = [];
  let far = startSlab - 2000;
  let top: number = PLATFORM.baseTop;
  const counts = sectionPlatforms(platforms, paced ? PLATFORM_SEGMENTS.share : PLATFORM_SECTIONS.share);
  counts.forEach((count, section) => {
    const tier = TIERS[sectionDifficulty(params.difficulty, paced ? Math.min(1, section) : section)];
    // Pohyblivá plošina uprostřed třetího úseku, s `movingPlatforms` i druhého; nikdy na checkpointu ani v cíli.
    // S úseky průběhu jen v úseku 2 za jeho `shuttleAt` – v úseku 3 by čekání vzalo rychlosti úseku smysl.
    const shuttleAt = paced ? (section === 1 ? Math.floor(count * PLATFORM_SEGMENTS.shuttleAt) : -1) : section === 2 || (section === 1 && params.movingPlatforms) ? Math.floor(count / 2) : -1;
    for (let i = 0; i < count; i += 1) {
      const last = section === counts.length - 1 && i === count - 1;
      const shuttle = i === shuttleAt && i > 0 && !last;
      const rise = shuttle ? 0 : rng.int(-tier.rise, tier.rise);
      const nextTop = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop, top + rise));
      if (shuttle) {
        const [shortest, longest] = paced ? PLATFORM_SEGMENTS.shuttleGap : PLATFORM_LEVEL.shuttleGap;
        const gap = rng.int(shortest, longest);
        const ride = shuttleBody(far, gap, top);
        extras.push(ride);
        // Úseky průběhu: mince u hrany, kde se na plošinu čeká, a mince, která jede s ní – čekání není mrtvý čas.
        if (paced && params.coins && params.collectAll !== true) extras.push(coin(far - 600, top + 300), { ...coin(ride.z, top + 300), kinematic: true, vz: ride.vz, period: ride.period });
        far += gap;
      }
      const from = far;
      if (!shuttle) far += Math.min(rng.int(tier.gap[0], tier.gap[1]), maxGap(nextTop - top));

      if (last && paced) {
        // Aréna bosse: schod a římsa (checkpoint – zásah bosse vrátí hráče sem, ne na začátek úseku 3), pak jáma o
        // `pit` níž. Schod stojí ve výšce, kterou by měla rovná deska (`nextTop`), takže skok do arény je stejný jako
        // před R5; dno drží celou jámu v mezích výšek. Konec arény je tam, kde byl konec rovné desky: délka úrovně a
        // hranice úseků se nehnou.
        const { pit, stairs } = PLATFORM_SEGMENTS;
        const floor = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop - pit, nextTop - pit / 2));
        const step = { near: from + Math.min(far - from, maxGap(floor + pit / 2 - top)), top: floor + pit / 2 };
        const ledge = { near: step.near + stairs.step + stairs.gap, top: floor + pit };
        slabs.push(slab(step.near, step.near + stairs.step, step.top), slab(ledge.near, ledge.near + stairs.ledge, ledge.top));
        const near = ledge.near + stairs.ledge;
        far += PLATFORM_SEGMENTS.arena;
        top = floor;
        slabs.push(slab(near, far, top));
        if (params.checkpoints) extras.push(checkpointBody(ledge.near + 800, ledge.top));
        // Mince na schodu a římse; poslední na dně jámy za dosahem bosse, 3 m před cílem.
        if (params.coins && params.collectAll !== true) extras.push(coin(step.near + stairs.step / 2, step.top + 300), coin(ledge.near + 1800, ledge.top + 300), coin(ledge.near + 3000, ledge.top + 300), coin(far - 3000, top + 300));
        break;
      }
      const near = far;
      far = near + (last ? finalSlab : rng.int(tier.slab[0], tier.slab[1]));
      top = nextTop;
      slabs.push(slab(near, far, top));
      if (last) break;

      const mid = Math.floor((near + far) / 2);
      // Úsek začíná checkpointem na plošině bez hrotu – po návratu se nezačíná skokem přes hrot.
      if (i === 0 && section > 0) {
        starts.push(near);
        if (params.checkpoints) extras.push(checkpointBody(near + 800, top));
      }
      // S úseky průběhu i uprostřed úseků 2 a 3 (každá `checkpointEvery`. plošina, ta je vždy bez hrotu): pád nevrací na začátek dlouhého úseku 2.
      if (paced && params.checkpoints && section > 0 && i % PLATFORM_SEGMENTS.checkpointEvery === PLATFORM_SEGMENTS.checkpointEvery - 1 && i % tier.spikeEvery !== 0) extras.push(checkpointBody(near + 800, top));
      if (i > 0 && i % tier.spikeEvery === 0) {
        extras.push(spikeBody(mid, top));
        // Mince nad hrotem odmění skok přes něj.
        spots.coinSpots.push({ z: mid, y: top + 1400 });
      } else {
        // S úseky průběhu má rozjezd jen prostřední minci: hra pak k finále houstne, místo aby řídla.
        for (let c = -1; c <= 1; c += 1) if (!paced || section > 0 || c === 0) spots.coinSpots.push({ z: mid + c * 1000, y: top + 300 });
        spots.runMids.push({ z: mid, y: top + 300 });
        spots.runSides.push({ z: mid - 1000, y: top + 300 }, { z: mid + 1000, y: top + 300 });
      }
    }
  });

  const lastSlab = slabs[slabs.length - 1] as BodyInit;
  const goalZ = lastSlab.z + lastSlab.d / 2 - 1500;
  // Past úseku 2: hroty od `trapFrom` do `trapUntil` ‰ trati vyjíždějí a zajíždějí (stejné místo, stejný počet těl).
  const trapped = paced ? extras.map((body) => (body.kind === 'spikes' && body.z * 1000 >= goalZ * PLATFORM_SEGMENTS.trapFrom && body.z * 1000 < goalZ * PLATFORM_SEGMENTS.trapUntil ? pistonBody(body.z, body.y) : body)) : extras;
  const bodies = [playerBody(), ...slabs, ...trapped];
  placeCoins(bodies, params, spots);
  bodies.push({ role: 'goal', kind: 'finish', x: 0, y: top, z: goalZ, w: PLATFORM.slabW, h: 3 * UNIT, d: 400, solid: false });
  return { level: { bodies, length: goalZ, sectionStarts: starts }, platforms };
}

/** Úroveň z úseků natažená nebo zkrácená po plošinách do `minTicks`..`maxTicks` odhadu robota a aspoň na `lengthM`. */
function sectionedLevel(seed: number, params: PlatformLevelParams): ArcadeLevel {
  const ticks = (level: ArcadeLevel): number => platformPaceTicks(level, params.difficulty, params.segments === true);
  const short = (level: ArcadeLevel): boolean => ticks(level) < PLATFORM_SECTIONS.minTicks || level.length < params.lengthM * UNIT;
  let extra = 0;
  let built = sectionedLayout(seed, params, extra);
  while (short(built.level) && built.platforms < PLATFORM_SECTIONS.maxPlatforms) built = sectionedLayout(seed, params, (extra += 1));
  while (ticks(built.level) > PLATFORM_SECTIONS.maxTicks && built.platforms > 3) built = sectionedLayout(seed, params, (extra -= 1));
  return built.level;
}

export const platformLevel: GeneratorPiece<PlatformLevelParams> = {
  id: 'platform_level',
  params: generatorParams,
  roles: ['player', 'platform', 'hazard', 'collectible', 'checkpoint', 'goal'],
  cost: (params) => {
    const slabs = params.sections === undefined ? Math.ceil((params.lengthM * UNIT) / (TIERS[params.difficulty].slab[0] + TIERS[params.difficulty].gap[0])) + 2 : PLATFORM_SECTIONS.maxPlatforms + 1;
    return { bodies: 2 + slabs * 3 + PLATFORM_LEVEL.maxCoins, rules: (params.checkpoints ? 5 : 4) + (params.sections === undefined ? 0 : 1) };
  },
  generate: (seed, params) => {
    if (params.sections !== undefined) return sectionedLevel(seed, params);
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const length = (params.movingPlatforms ? Math.min(params.lengthM, PLATFORM_LEVEL.maxMovingLengthM) : params.lengthM) * UNIT;
    const { startSlab, finalSlab } = PLATFORM_LEVEL;

    const slabs: BodyInit[] = [slab(-2000, startSlab - 2000, PLATFORM.baseTop)];
    const extras: BodyInit[] = [];
    /** Místa na zemi plošin bez hrotu: středy napřed, pak po stranách – sbírání všeho na ně spoléhá. */
    const spots = { coinSpots: [] as Spot[], runMids: [] as Spot[], runSides: [] as Spot[] };
    const { coinSpots, runMids, runSides } = spots;

    let far = startSlab - 2000;
    let top: number = PLATFORM.baseTop;
    for (let index = 1; far < length - finalSlab; index += 1) {
      const shuttle = params.movingPlatforms && index % 5 === 3;
      const rise = shuttle ? 0 : rng.int(-tier.rise, tier.rise);
      const nextTop = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop, top + rise));
      const dh = nextTop - top;

      if (shuttle) {
        // Pohyblivá plošina kyvadlem mezi hranami široké mezery.
        const gap = rng.int(PLATFORM_LEVEL.shuttleGap[0], PLATFORM_LEVEL.shuttleGap[1]);
        extras.push(shuttleBody(far, gap, top));
        far += gap;
      } else {
        const gap = Math.min(rng.int(tier.gap[0], tier.gap[1]), maxGap(dh));
        far += gap;
      }

      const last = far + tier.slab[0] + finalSlab >= length;
      const len = last ? finalSlab : rng.int(tier.slab[0], tier.slab[1]);
      const near = far;
      far = near + len;
      top = nextTop;
      slabs.push(slab(near, far, top));
      if (last) break;

      const mid = Math.floor((near + far) / 2);
      if (index % tier.spikeEvery === 0) {
        extras.push(spikeBody(mid, top));
        // Mince nad hrotem odmění skok přes něj.
        coinSpots.push({ z: mid, y: top + 1400 });
      } else {
        for (let c = -1; c <= 1; c += 1) coinSpots.push({ z: mid + c * 1000, y: top + 300 });
        runMids.push({ z: mid, y: top + 300 });
        runSides.push({ z: mid - 1000, y: top + 300 }, { z: mid + 1000, y: top + 300 });
      }
      if (params.checkpoints && index % 4 === 0) extras.push(checkpointBody(near + 800, top));
    }

    const lastSlab = slabs[slabs.length - 1] as BodyInit;
    const goalZ = lastSlab.z + lastSlab.d / 2 - 1500;
    const bodies = [playerBody(), ...slabs, ...extras];
    placeCoins(bodies, params, spots);
    bodies.push({ role: 'goal', kind: 'finish', x: 0, y: top, z: goalZ, w: PLATFORM.slabW, h: 3 * UNIT, d: 400, solid: false });
    return { bodies, length: goalZ };
  },
};

/** Ovládání plošinovky z parametrů úrovně; `feel` jen, když ho úroveň nese – svět bez něj je dnešní. */
export function platformControlRef(params: Pick<PlatformLevelParams, 'doubleJump' | 'feel'>): PieceRef {
  return { id: 'platform', params: params.feel === undefined ? { doubleJump: params.doubleJump } : { doubleJump: params.doubleJump, feel: params.feel } };
}

/**
 * Pravidla plošinovky: hrot, mince, cíl, pád; s checkpointy pád vrací místo prohry, se sběrem cíl čeká na všechny věci.
 * Se životy (P36A T2) hrot ubere život a vrátí hráče na poslední checkpoint (bez něj na start); hrot zůstává a vteřinu
 * milosti jím hráč projde. Úroveň z úseků (P36A T4) má hodiny `seconds` (`platformSeconds`).
 */
export function platformRules(params: Pick<PlatformLevelParams, 'checkpoints' | 'collectAll'>, health?: number, seconds?: number): PieceRef[] {
  const rules: PieceRef[] = [
    { id: 'hit', params: health === undefined ? { role: 'hazard', effect: 'lose' } : { role: 'hazard', effect: 'damage', grace: HIT_GRACE, after: 'respawn' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: params.collectAll === true ? { allItems: true } : {} },
    { id: 'fall_out', params: { belowY: PLATFORM.fallBelowY, effect: params.checkpoints ? 'respawn' : 'lose' } },
  ];
  if (params.checkpoints) rules.push({ id: 'checkpoint', params: {} });
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  if (seconds !== undefined) rules.push({ id: 'time_limit', params: { seconds } });
  return rules;
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

interface Span {
  readonly near: number;
  readonly far: number;
  readonly top: number;
}

/** Kam až deska sahá po trati – u pohyblivé obě krajní polohy. */
function spanOf(body: BodyInit): Span {
  const shift = body.kinematic === true ? (body.vz ?? 0) * (body.period ?? 0) : 0;
  const lo = body.z + Math.min(0, shift);
  const hi = body.z + Math.max(0, shift);
  return { near: lo - body.d / 2, far: hi + body.d / 2, top: body.y + body.h };
}

/**
 * Tvrzení „hratelné z konstrukce“ nad hotovou úrovní: vrací porušení, prázdné
 * pole = hratelná. U pohyblivé plošiny se mezera měří k její bližší krajní
 * poloze (hráč na ni počká).
 */
export function checkPlatformLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const platforms = level.bodies.filter((body) => body.role === 'platform');
  const path = platforms.map((body) => ({ body, span: spanOf(body) })).sort((a, b) => a.span.near - b.span.near);

  path.forEach(({ body, span }, index) => {
    const next = path[index + 1];
    if (next === undefined) return;
    // Z pohyblivé plošiny se skáče, když je u další hrany; na ni, když je u předchozí.
    const from = span.far;
    const to = next.span.near;
    const gap = to - from;
    const dh = next.span.top - span.top;
    // Seskok smí být hlubší – do jámy bosse (R5) se z římsy padá o `pit`.
    if (dh > PLATFORM.maxRise || -dh > Math.max(PLATFORM.maxRise, PLATFORM_SEGMENTS.pit)) issues.push(`step of ${m(dh)} at ${m(to)} is higher than a jump allows`);
    if (gap > maxGap(dh)) issues.push(`gap of ${m(gap)} at ${m(from)} is wider than a jump (${m(maxGap(dh))})`);
    if (dh > 0 && gap >= PLATFORM.playerD && riseTicks(dh) * PLATFORM.maxRun > gap - PLATFORM.playerD) issues.push(`ledge at ${m(to)} is too high to clear over a ${m(gap)} gap`);
  });

  for (const spike of level.bodies.filter((body) => body.role === 'hazard')) {
    // Past (P46B T6) jezdí kyvadlem nahoru a dolů: deska je tam, kde ji past v nejvyšší poloze přečnívá.
    const rise = spike.kinematic === true ? Math.max(0, (spike.vy ?? 0) * (spike.period ?? 0)) : 0;
    const host = path.find(({ span }) => spike.z > span.near && spike.z < span.far && (rise === 0 ? spike.y === span.top : spike.y + spike.h <= span.top && spike.y + spike.h + rise > span.top));
    if (host === undefined) {
      issues.push(`spikes at ${m(spike.z)} do not sit on a platform`);
      continue;
    }
    if (spike.y + spike.h + rise - host.span.top > PLATFORM_JUMP_PEAK / 2) issues.push(`spikes at ${m(spike.z)} are too tall to jump`);
    const before = spike.z - spike.d / 2 - host.span.near;
    const after = host.span.far - (spike.z + spike.d / 2);
    if (before < PLATFORM.spikeMargin || after < PLATFORM.spikeMargin) issues.push(`spikes at ${m(spike.z)} leave no room to run up or land`);
  }

  const player = level.bodies[0];
  const first = path[0];
  if (player === undefined || first === undefined || player.z <= first.span.near || player.z >= first.span.far || player.y !== first.span.top) issues.push('the player does not start on the first platform');
  const goal = level.bodies.find((body) => body.role === 'goal');
  const last = path[path.length - 1];
  if (goal === undefined || last === undefined || goal.z <= last.span.near || goal.z >= last.span.far || goal.y !== last.span.top) issues.push('no goal on the last platform');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
