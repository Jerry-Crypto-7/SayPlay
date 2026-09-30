/**
 * Souboj (P32E T3): úder s odhozením a HP, nepřítel s telegrafovaným úderem.
 *
 * Co by vypadalo dobře a přitom bylo špatně: souboj, který vyhraje i nečinný
 * hráč, telegraf, po kterém úder dopadne i na toho, kdo uhnul, a robot, který
 * vyhrává jen proto, že nepřítel nikdy neudeří. Hlídá to tenhle test na 200
 * semínkách – a to, že staré duely (`duel`) mají hash beze změny.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { createCompileRng } from '@/play/compile/rng';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import duelFixture from '../__fixtures__/duel.json';
import { arcadeWorldOf } from '../compile';
import { type ArcadeInput, type ArcadeWorld, BODY, BUTTON, HEADER, NO_INPUT, bodyBase, bodyHp } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { DIRECTIONS, arenaAxis } from '../pieces/arena';
import { FIGHT, FIGHT_PHASE, type FightParams, checkFightLevel, fightArena, phaseOf, phaseTicksLeft, strikeDirectionOf } from '../pieces/fight';
import { runBot, verifyArcade } from '../verify';

/** 200 semínek z `pure-rand` (přes `createCompileRng`, jedinou povolenou cestu). */
const SEEDS = (() => {
  const rng = createCompileRng(20_260_930);
  return Array.from({ length: 200 }, () => rng.int(1, 2 ** 31 - 2));
})();

function worldOf(seed: number, raw: Partial<FightParams> = {}, health?: number): ArcadeWorld {
  const parts = fightArena.parts(seed, fightArena.params.parse(raw), health);
  if (parts.issues !== undefined && parts.issues.length > 0) throw new Error(`fight/${seed}: ${parts.issues.join('; ')}`);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(`fight/${seed}: ${built.issues.join('; ')}`);
  return built.world;
}

function run(world: ArcadeWorld) {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const player = state[HEADER.player] as number;
  return { state, player, tick: (input: ArcadeInput = NO_INPUT) => step(state, input, program) };
}

const VARIANTS: readonly [string, Partial<FightParams>][] = [
  ['duel (defaults)', {}],
  ['three enemies', { enemies: 3 }],
  ['fastest, toughest single enemy', { enemySpeed: FIGHT.enemySpeed.max, enemyHp: FIGHT.enemyHp.max }],
];

describe('fight – a fair courtyard from every seed', () => {
  it.each(VARIANTS)('%s: every level passes checkFightLevel', (_name, raw) => {
    for (const seed of SEEDS) expect(checkFightLevel(fightArena.generate(seed, fightArena.params.parse(raw))), `seed ${seed}`).toEqual([]);
  });

  it('checkFightLevel refuses an enemy next to the player, a level without enemies and a player without HP', () => {
    const level = fightArena.generate(1, fightArena.params.parse({}));
    const [player, enemy] = level.bodies as [(typeof level.bodies)[number], (typeof level.bodies)[number]];
    expect(checkFightLevel({ ...level, bodies: [player, { ...enemy, z: player.z + 2000 }] }).join(' ')).toMatch(/starts 2\.0 m from the player/);
    expect(checkFightLevel({ ...level, bodies: [player] })).toContain('no enemy to fight');
    expect(checkFightLevel({ ...level, bodies: [{ ...player, hp: 0 }, enemy] })).toContain('the player has no HP');
  });

  it('lives from the spec become the player HP and the mode keeps no life counter', () => {
    const parts = fightArena.parts(1, fightArena.params.parse({}), 3);
    expect(parts.level.bodies[0]?.hp).toBe(3);
    expect('health' in parts && parts.health === undefined).toBe(true);
  });
});

describe('fight – attack, knockback and health', () => {
  it('a swing hits the enemy in the arc: hit effect, one HP, knocked back along the swing, staggered', () => {
    const world = worldOf(1);
    const g = run(world);
    // Hráč stojí těsně před nepřítelem a dívá se na něj (startovní pohled je +z).
    const e = bodyBase(1);
    const p = bodyBase(g.player);
    g.state[e + BODY.x] = g.state[p + BODY.x] as number;
    g.state[e + BODY.z] = (g.state[p + BODY.z] as number) + 1500;
    const effects = g.tick({ buttons: BUTTON.ATTACK, axis: 0 });
    expect(effects).toContainEqual({ kind: 'hit', body: 1, by: g.player, amount: FIGHT.damage });
    expect(bodyHp(g.state, 1)).toBe(FIGHT.enemyHp.default - FIGHT.damage);
    expect(phaseOf(g.state, 1)).toBe(FIGHT_PHASE.stagger);
    expect([g.state[e + BODY.vx], g.state[e + BODY.vz]]).toEqual([0, FIGHT.knockback]);
    // Na rozestupu úder nic neudělá, i když nepřítel stojí v dosahu.
    g.state[e + BODY.z] = (g.state[p + BODY.z] as number) + 1500;
    for (let k = 1; k < FIGHT.attackCooldown; k += 1) expect(g.tick({ buttons: BUTTON.ATTACK, axis: 0 }).some((effect) => effect.kind === 'hit')).toBe(false);
    expect(bodyHp(g.state, 1)).toBe(FIGHT.enemyHp.default - FIGHT.damage);
  });

  it('a swing misses an enemy behind the player or out of reach', () => {
    for (const offset of [-1500, FIGHT.attackReach + 200]) {
      const g = run(worldOf(1));
      const e = bodyBase(1);
      g.state[e + BODY.x] = g.state[bodyBase(g.player) + BODY.x] as number;
      g.state[e + BODY.z] = (g.state[bodyBase(g.player) + BODY.z] as number) + offset;
      expect(g.tick({ buttons: BUTTON.ATTACK, axis: 0 }).some((effect) => effect.kind === 'hit'), `offset ${offset}`).toBe(false);
      expect(bodyHp(g.state, 1)).toBe(FIGHT.enemyHp.default);
    }
  });

  it('the enemy approaches, telegraphs at least 400 ms standing still, strikes, then backs off', () => {
    const g = run(worldOf(1));
    const phases: number[] = [];
    let hitAt = -1;
    for (let tick = 0; tick < 600 && hitAt < 0; tick += 1) {
      const effects = g.tick();
      phases.push(phaseOf(g.state, 1));
      if (effects.some((effect) => effect.kind === 'hit' && effect.body === g.player)) hitAt = tick;
    }
    expect(hitAt).toBeGreaterThan(0);
    const telegraph = phases.filter((phase) => phase === FIGHT_PHASE.telegraph).length;
    expect(telegraph * 1000).toBeGreaterThanOrEqual(400 * 60);
    expect(phases.indexOf(FIGHT_PHASE.telegraph)).toBeGreaterThan(0);
    expect(phases[phases.length - 1]).toBe(FIGHT_PHASE.strike);
    expect(bodyHp(g.state, g.player)).toBe(FIGHT.playerHp.default - FIGHT.damage);
    // Po úderu ustoupí: vzdálenost od hráče roste.
    const gap = (): number => Math.hypot((g.state[bodyBase(1) + BODY.x] as number) - (g.state[bodyBase(g.player) + BODY.x] as number), (g.state[bodyBase(1) + BODY.z] as number) - (g.state[bodyBase(g.player) + BODY.z] as number));
    for (let k = 0; k < FIGHT.strike + 1; k += 1) g.tick();
    expect(phaseOf(g.state, 1)).toBe(FIGHT_PHASE.retreat);
    const before = gap();
    for (let k = 0; k < 10; k += 1) g.tick();
    expect(gap()).toBeGreaterThan(before);
  });
});

/**
 * Úhyb: nečinný hráč čeká na první telegraf, pak po `reaction` tikách uhne
 * (vlevo, vpravo, nebo od nepřítele) a drží to do úderu. Zásah nesmí padnout
 * nikdy; bez úhybu týž úder dopadne, takže test není prázdný.
 */
function dodgeRun(seed: number, reaction: number, dodge: 'left' | 'right' | 'away' | 'stand'): { hitsTaken: number } {
  const g = run(worldOf(seed));
  let start = -1;
  for (let tick = 0; tick < 900; tick += 1) {
    const telegraph = phaseOf(g.state, 1) === FIGHT_PHASE.telegraph;
    if (start < 0 && telegraph) start = tick;
    let input: ArcadeInput = NO_INPUT;
    if (start >= 0 && tick - start >= reaction && dodge !== 'stand') {
      const dir = DIRECTIONS[strikeDirectionOf(g.state, 1)]!;
      const [x, z] = dodge === 'away' ? [dir.dx, dir.dz] : dodge === 'left' ? [dir.dz, -dir.dx] : [-dir.dz, dir.dx];
      input = { buttons: 0, axis: arenaAxis(x, z) };
    }
    const hp = bodyHp(g.state, g.player);
    g.tick(input);
    if (bodyHp(g.state, g.player) < hp) return { hitsTaken: 1 };
    // Úder, kterému uhýbal, skončil – dál už nic.
    if (start >= 0 && phaseOf(g.state, 1) === FIGHT_PHASE.retreat) return { hitsTaken: 0 };
  }
  throw new Error(`seed ${seed}: the enemy never struck`);
}

describe('fight – a dodge inside the telegraph window always averts the strike', () => {
  it.each([0, 8, 16])('reaction %i ticks: left, right and away all avert it on 200 seeds; standing still does not', (reaction) => {
    for (const seed of SEEDS) {
      for (const dodge of ['left', 'right', 'away'] as const) expect(dodgeRun(seed, reaction, dodge).hitsTaken, `seed ${seed} ${dodge}`).toBe(0);
      expect(dodgeRun(seed, reaction, 'stand').hitsTaken, `seed ${seed} stand`).toBe(1);
    }
  });

  /**
   * Úhyb výše vždy opustí i dosah, takže by prošel i úder mířený znovu na hráče.
   * Tady hráč zůstane v dosahu, jen mimo zamčený oblouk: úder jde tam, kam
   * ukázal telegraf, a mine ho. Ve zamčeném směru na stejné vzdálenosti dopadne.
   */
  it.each([
    ['90° to the left, inside reach', 8, false],
    ['90° to the right, inside reach', -8, false],
    ['straight along the locked direction', 0, true],
  ] as const)('the strike goes where the telegraph pointed: a player moved %s (turn %i) is hit – %s', (_name, turn, lands) => {
    for (const seed of SEEDS.slice(0, 50)) {
      const g = run(worldOf(seed));
      while (phaseOf(g.state, 1) !== FIGHT_PHASE.telegraph) g.tick();
      const e = bodyBase(1);
      const p = bodyBase(g.player);
      const dir = DIRECTIONS[(((strikeDirectionOf(g.state, 1) + turn) % 32) + 32) % 32]!;
      g.state[p + BODY.x] = (g.state[e + BODY.x] as number) + Math.trunc((dir.dx * 1500) / 1000);
      g.state[p + BODY.z] = (g.state[e + BODY.z] as number) + Math.trunc((dir.dz * 1500) / 1000);
      g.state[p + BODY.vx] = 0;
      g.state[p + BODY.vz] = 0;
      const hp = bodyHp(g.state, g.player);
      while (phaseOf(g.state, 1) === FIGHT_PHASE.telegraph) g.tick();
      expect(phaseOf(g.state, 1), `seed ${seed}`).toBe(FIGHT_PHASE.strike);
      expect(bodyHp(g.state, g.player), `seed ${seed}`).toBe(lands ? hp - FIGHT.damage : hp);
    }
  });
});

describe('fight – the bot wins, the idle player loses, replays are stable', () => {
  it.each(VARIANTS)('%s: the bot wins at least 90 % of 200 seeds and the idle player loses every one', { timeout: 120_000 }, (_name, raw) => {
    let wins = 0;
    for (const seed of SEEDS) {
      const world = worldOf(seed, raw);
      if (runBot(world).outcome === 'won') wins += 1;
      expect(replay(world, [], ARCADE_LIBRARY).outcome, `idle seed ${seed}`).toBe('lost');
    }
    expect(wins).toBeGreaterThanOrEqual(180);
  });

  it('with three enemies the fight is won only once the last one is down, never while one still stands', () => {
    // `every` → `some` by vyhrálo po prvním KO – robot by pořád „vyhrával“ a výhra by přišla dřív.
    let partial = 0;
    for (const seed of SEEDS.slice(0, 30)) {
      const world = worldOf(seed, { enemies: 3 });
      const bot = runBot(world);
      const g = run(world);
      let next = 0;
      for (let tick = 0; g.state[HEADER.runState] === 0; tick += 1) {
        while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
        const event = bot.inputs[next];
        g.tick(event !== undefined && event.tick === tick ? event : NO_INPUT);
        const standing = [1, 2, 3].filter((i) => bodyHp(g.state, i) > 0).length;
        if (standing > 0 && standing < 3) partial += 1;
        expect(g.state[HEADER.runState] === 1, `seed ${seed} tick ${tick}: ${standing} enemies standing`).toBe(standing === 0 && bodyHp(g.state, g.player) > 0);
      }
    }
    expect(partial).toBeGreaterThan(0);
  });

  it('verifyArcade passes and two replays of the bot record end in the same state', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const verdict = verifyArcade(worldOf(seed));
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.replayEqual).toBe(true);
      expect(replay(worldOf(seed), verdict.bot.inputs, ARCADE_LIBRARY).hash).toBe(verdict.bot.hash);
    }
  });

  it('the telegraph is in the hashed state: the same record gives the same phase and ticks left', () => {
    const a = run(worldOf(SEEDS[0]!));
    const b = run(worldOf(SEEDS[0]!));
    for (let tick = 0; tick < 200; tick += 1) {
      a.tick();
      b.tick();
      expect([phaseOf(a.state, 1), phaseTicksLeft(a.state, 1)]).toEqual([phaseOf(b.state, 1), phaseTicksLeft(b.state, 1)]);
    }
  });
});

describe('fight – saved duel games do not move', () => {
  const duel = (difficulty: string): GameSpecV1 => {
    const read = readGameSpec({ ...(duelFixture as object), controlParams: { difficulty } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    return read.value;
  };
  // Otisky z `features/p32e-arena` @ 35f7084e, před T3: [svět, konec robotova běhu, tik výhry].
  it.each([
    ['easy', [['05b601f3', '89016347', 380], ['4b39eba7', 'c5add068', 405], ['10735694', '32126b10', 404]]],
    ['normal', [['0e9ea07c', '14cfe72e', 357], ['5b10ad2b', '0a791064', 387], ['94e71314', '2f363169', 375]]],
    ['hard', [['345a17a9', 'bd49440b', 346], ['7d421cee', '7a1d4540', 322], ['6077e8df', '6b5eb94f', 329]]],
  ] as const)('duel %s: world hash and bot run unchanged on seeds 1–3', (difficulty, pins) => {
    const spec = duel(difficulty);
    const seen = pins.map((_pin, index) => {
      const made = arcadeWorldOf(spec, index + 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const bot = runBot(made.world);
      return [canonicalHash(made.world), bot.hash, bot.tick];
    });
    expect(seen).toEqual(pins);
  });
});
