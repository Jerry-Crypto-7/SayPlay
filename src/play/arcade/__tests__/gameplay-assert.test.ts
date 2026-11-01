/**
 * Herní aserce nad stopou stavu (P68 T5) na ručně stavěných světech bez nových her: pravidlo-náhražka, které vydá
 * `win` bez průjezdu cílem, neprojde `stunt`; svět, kde se `yawStep` nehne, neprojde `railfps`; vyhrávající nečinný
 * hráč shodí `idle-loses`. Ke každému zápornému případu kladný, ať kontrola neprochází jen tím, že vždy selže.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { GameSpecV1 } from '../../spec';
import { arcadeWorldOf } from '../compile';

import { RAILFPS_AXES, RAILFPS_KEEPER_ROLE, RAILFPS_SLOTS, RAILFPS_YAW_STEPS } from '../../genre/p68-contract';
import { type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, type BodyInit, type ControlPiece, HEADER, NO_INPUT, type RulePiece, bodyBase } from '../contract';
import { assertGame, traceRun } from '../gameplay-assert';
import { type ArcadeLibrary, buildWorld } from '../kernel';

interface DriveParams {
  readonly speed: number;
  readonly rig: number;
  readonly aim: boolean;
}

/** Ovládání: hráč jede `speed` jednotek za tik po +z; s `aim` zapíše nejbližší krok osy do `yawStep` držáku. */
const drive: ControlPiece<DriveParams> = {
  id: 'drive',
  params: z.custom<DriveParams>(),
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    state[bodyBase(player) + BODY.vz] = params.speed;
    if (params.aim && input.axis !== 0) state[bodyBase(params.rig) + RAILFPS_SLOTS.yawStep] = Math.round((input.axis * RAILFPS_YAW_STEPS) / 1000);
  },
};

/** Pravidlo-náhražka: v tiku `at` vydá `kind` bez ohledu na stav. */
function at(kind: 'win' | 'lose'): RulePiece<{ readonly at: number }> {
  return {
    id: `${kind}_at`,
    trigger: 'tick',
    params: z.custom<{ readonly at: number }>(),
    roles: [],
    cost: () => ({ bodies: 0, rules: 1 }),
    fire: (ctx, params) => (ctx.state[HEADER.tick] === params.at ? [{ kind }] : []),
  };
}

/** Výhra jen za stisk `TAP` – nečinný hráč ji nedostane. */
const winOnTap: RulePiece<Record<string, never>> = {
  id: 'win_on_tap',
  trigger: 'press',
  params: z.object({}),
  roles: [],
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: (ctx) => ((ctx.input.buttons & BUTTON.TAP) !== 0 ? [{ kind: 'win' }] : []),
};

const library: ArcadeLibrary = {
  controls: { drive },
  rules: { win_at: at('win'), lose_at: at('lose'), win_on_tap: winOnTap },
  generators: {},
  bots: {
    // Mění osu po 10 tikách přes pět kroků a od tiku 120 ťuká.
    sweep: {
      id: 'sweep',
      params: z.object({}),
      roles: [],
      reactionTicks: 0,
      cost: () => ({ bodies: 0, rules: 0 }),
      decide: (observation) => ({ buttons: observation.tick >= 120 ? BUTTON.TAP : 0, axis: RAILFPS_AXES[RAILFPS_YAW_STEPS - 2 + (Math.floor(observation.tick / 10) % 5)] as number }),
    },
    idle: { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT },
  },
};

const player: BodyInit = { role: 'player', kind: 'car', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 2000, solid: false };
/** Držák `railfps`: mrtvá předloha daleko od trati, jako počítadlo háčků. */
const rig: BodyInit = { role: 'thing', kind: RAILFPS_KEEPER_ROLE, x: 0, y: 0, z: -50_000, w: 1, h: 1, d: 1, solid: false, template: true };

function world(options: { readonly speed?: number; readonly aim?: boolean; readonly rules: readonly (readonly [id: string, at?: number])[] }): ArcadeWorld {
  const level: ArcadeLevel = { bodies: [player, rig], length: 100_000 };
  const built = buildWorld(
    {
      seed: 7,
      control: { id: 'drive', params: { speed: options.speed ?? 0, rig: 1, aim: options.aim ?? false } },
      rules: options.rules.map(([id, tick]) => ({ id, params: tick === undefined ? {} : { at: tick } })),
      bot: { id: 'sweep', params: {} },
      level,
    },
    library,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const result = (id: string, game: string, w: ArcadeWorld) => {
  const found = assertGame(game, w, library).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no result ${id}`);
  return found;
};

describe('state trace', () => {
  it('records state per tick, inputs and the end of the run, without rule effects', () => {
    const trace = traceRun(world({ speed: 100, aim: true, rules: [['win_at', 200]] }), 'bot', 5400, library);
    expect(trace.outcome).toBe('won');
    expect(trace.frames.length - 1).toBe(trace.endTick);
    expect(trace.frames[0]?.tick).toBe(0);
    const tenth = trace.frames[10];
    expect(tenth?.tick).toBe(10);
    expect(tenth?.state[bodyBase(0) + BODY.z]).toBe(1000);
    expect(tenth?.yawStep).not.toBeNull();
    expect(Object.keys(trace.frames[1] ?? {}).sort()).toEqual(['input', 'outcome', 'state', 'tick', 'yawStep']);
    expect(traceRun(world({ rules: [['win_at', 200]] }), 'idle', 5400, library).inputs).toEqual([]);
  });
});

describe('stunt: crosses-finish reads the vehicle position, not the win effect', () => {
  it('fails when a stand-in rule emits win without the vehicle crossing the finish', () => {
    const standIn = world({ speed: 0, rules: [['win_at', 30]] });
    expect(result('bot-wins', 'stunt', standIn).pass).toBe(true);
    const crossed = result('crosses-finish', 'stunt', standIn);
    expect(crossed.pass).toBe(false);
    expect(crossed.evidence).toContain('< finish 100.0 m');
  });

  it('passes when the vehicle body drives past the finish line', () => {
    const crossed = result('crosses-finish', 'stunt', world({ speed: 120, rules: [['win_at', 1000]] }));
    expect(crossed.pass).toBe(true);
    expect(crossed.evidence).toMatch(/^player z 100\.\d m >= finish 100\.0 m/);
  });
});

describe('railfps: aims needs yawStep to move', () => {
  it('fails when yawStep never changes although the bot sweeps the axis', () => {
    const aims = result('aims', 'railfps', world({ aim: false, rules: [['win_at', 200]] }));
    expect(aims.pass).toBe(false);
    expect(aims.evidence).toContain('1 distinct values [0]');
  });

  it('passes when the control writes the axis into yawStep', () => {
    const aims = result('aims', 'railfps', world({ aim: true, rules: [['win_at', 200]] }));
    expect(aims.pass).toBe(true);
    expect(aims.evidence).toContain('5 distinct values');
  });

  it('fails without a railfps_rig body', () => {
    const level: ArcadeLevel = { bodies: [player], length: 100_000 };
    const built = buildWorld({ seed: 7, control: { id: 'drive', params: { speed: 0, rig: 0, aim: false } }, rules: [{ id: 'win_at', params: { at: 50 } }], bot: { id: 'sweep', params: {} }, level }, library);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(result('aims', 'railfps', built.world)).toMatchObject({ pass: false, evidence: 'no railfps_rig body (kind) holds yawStep' });
  });
});

describe('lose: an idle player that wins breaks it', () => {
  it('fails idle-loses when the game is won without any input', () => {
    const idle = result('idle-loses', 'minigolf', world({ rules: [['win_at', 30]] }));
    expect(idle.pass).toBe(false);
    expect(idle.evidence).toBe('idle: run won at tick 31 (needs lost by tick 5400)');
  });

  it('passes idle-loses when only an input wins and time runs out on the idle player', () => {
    const idle = result('idle-loses', 'minigolf', world({ rules: [['win_on_tap'], ['lose_at', 300]] }));
    expect(idle.pass).toBe(true);
    expect(result('bot-wins', 'minigolf', world({ rules: [['win_on_tap'], ['lose_at', 300]] })).pass).toBe(true);
  });
});

describe('buildshift: coins on the shift body, the weak player builds badly', () => {
  const shop = (goal?: number): ArcadeWorld => {
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'e2e', 'fixtures', 'p68-buildshift-spec.json'), 'utf8')) as GameSpecV1;
    const tuned = goal === undefined ? spec : ({ ...spec, controlParams: { generator: 'buildshift_shop', tuning: { goal } } } as GameSpecV1);
    const built = arcadeWorldOf(tuned, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  };
  const real = (id: string, w: ArcadeWorld) => assertGame('buildshift', w).find((entry) => entry.id === id) as { pass: boolean; evidence: string };

  it('reads the spend from the coins slot of the shift body, not from ammo or reserve', () => {
    expect(real('spends', shop())).toMatchObject({ pass: true, evidence: 'body 1.y 6 -> 4 at tick 10 after the build of body 7' });
  });

  it('loses with the bad layout at the fixture goal, so the weak player is not the winning bot', () => {
    expect(real('weak-loses', shop()).pass).toBe(true);
    expect(real('bad-build-loses', shop()).pass).toBe(true);
  });

  it('still fails when the bad layout serves a small goal in time (the gate is not decorative)', () => {
    expect(real('bad-build-loses', shop(6))).toMatchObject({ pass: false });
  });
});
