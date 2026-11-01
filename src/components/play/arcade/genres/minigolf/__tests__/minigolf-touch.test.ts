/**
 * Natažení zpět minigolfu (P68 T8): tah prstem od míčku dozadu míří proti tahu, délka tahu je síla, krátký tah ránu
 * zruší a výsledek je tentýž vstup jako šipky + mezerník. Hraje se na ručně postavené rovné dráze přes jádro (`step`).
 */
import { describe, expect, it } from 'vitest';

import { type ArcadeInput, type ArcadeState, type ArcadeWorld, BODY, BUTTON, HEADER, type InputEvent, NO_INPUT, bodyBase } from '@/play/arcade/contract';
import { buildWorld, hashArcade, instantiate, loadProgram, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { minigolfPartsOf, strokesOf } from '@/play/arcade/pieces/minigolf';
import { minigolfAim, minigolfDistance } from '@/play/arcade/pieces/minigolf-roll';

import { MINIGOLF_PULL, type Putt, keyPutt, pullBack, pullFor, puttInput, turnAxis } from '../minigolf-touch';

/** Rovná dráha bez překážek: odpaliště vzadu, jamka 9 m před ním – rána do 60 nabití nikde nenarazí. */
function world(): ArcadeWorld {
  const parts = minigolfPartsOf({ shape: 'straight', tiles: [[0, 0], [0, 1], [0, 2]], tee: [0, -1000], hole: [0, 8000], bumpers: [], mover: null, route: [[0, 8000]], par: 2, obstacles: 0 });
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const ball = (state: ArcadeState) => {
  const p = bodyBase(state[HEADER.player] as number);
  return { x: state[p + BODY.x] as number, z: state[p + BODY.z] as number, vx: state[p + BODY.vx] as number, vz: state[p + BODY.vz] as number, aim: state[p + BODY.aux0] as number, charge: state[p + BODY.aux1] as number };
};

interface Played {
  readonly log: InputEvent[];
  readonly state: ArcadeState;
}

/**
 * Hraje gesto tik po tiku jako `MinigolfTouch`: před každým tikem vezme `puttOf(tick, nabití ve stavu)`, vstup tiku
 * z `puttInput`, a po `done` už nic. Do záznamu jde jen nenulový vstup (jako relace).
 */
function play(puttOf: (tick: number, charge: number) => Putt, ticks = 400): Played {
  const w = world();
  const state = instantiate(w);
  const program = loadProgram(w, ARCADE_LIBRARY);
  const log: InputEvent[] = [];
  let done = false;
  for (let tick = 0; tick < ticks; tick += 1) {
    let input: ArcadeInput = NO_INPUT;
    if (!done) {
      const next = puttInput(puttOf(tick, Math.max(0, ball(state).charge)), Math.max(0, ball(state).charge));
      input = next.input;
      done = next.done;
    }
    if (input.buttons !== 0 || input.axis !== 0) log.push({ tick, ...input });
    step(state, input, program);
  }
  return { log, state };
}

/** Prst táhne o (`dx`, `dy`) px od startu (kamera míří osou `base`) a pustí v tiku `release`. */
const finger = (base: number, dx: number, dy: number, release: number) => (tick: number): Putt => ({ aim: pullBack(base, dx, dy), released: tick >= release });

/** Mezerník držený `hold` tiků s osou `axis`, pak puštěný (nabití při puštění ze stavu). */
const keyboard = (axis: number, hold: number) => (tick: number, charge: number): Putt => keyPutt(axis, tick < hold, charge);

/** Tah pro nabití `charge` přímo dolů (y obrazovky dolů). */
const pullOf = (charge: number): number => MINIGOLF_PULL.deadZone + charge * MINIGOLF_PULL.pxPerCharge;

describe('minigolf pull-back (P68 T8)', () => {
  it('putts forward when the finger pulls straight down, whichever way the camera looks', () => {
    expect(pullBack(0, 0, pullOf(20))).toEqual({ axis: 0, charge: 20 });
    // Kamera míří po +x (osa 500): tah dolů = rána po +x.
    expect(pullBack(500, 0, pullOf(20))?.axis).toBe(500);
    expect(pullBack(-500, 0, pullOf(20))?.axis).toBe(-500);
    const { state } = play(finger(0, 0, pullOf(20), 0));
    const rest = ball(state);
    expect(strokesOf(state)).toBe(1);
    expect(rest.x).toBe(0);
    expect(rest.z - -1000).toBe(minigolfDistance(20));
  });

  it('aims against the drag: pulling down-left sends the ball forward-right on screen, and back the other way', () => {
    // Scéna zrcadlí x jádra: obrazovka vpravo = +x při pohledu po +z, kladná osa míří doprava.
    const left = pullBack(0, -60, 80);
    const right = pullBack(0, 60, 80);
    expect(left?.axis).toBeGreaterThan(0);
    expect(left?.axis).toBeLessThan(500);
    expect(right?.axis).toBe(-(left?.axis ?? 0));
    // Míček opravdu jede doprava (+x) a dopředu.
    const { state } = play(finger(0, -60, 80, 0));
    expect(ball(state).x).toBeGreaterThan(0);
    expect(ball(state).z).toBeGreaterThan(-1000);
    // Tah nahoru (od míčku dopředu) = rána zpátky ke kameře.
    expect(Math.abs(pullBack(0, 0, -pullOf(10))?.axis ?? 0)).toBe(1000);
  });

  it('charges more for a longer pull and rolls the ball farther', () => {
    const short = pullBack(0, 0, 60);
    const long = pullBack(0, 0, 150);
    expect(short).not.toBeNull();
    expect(long?.charge).toBeGreaterThan(short?.charge ?? Infinity);
    expect(pullBack(0, 0, 10_000)?.charge).toBe(60);
    const near = play(finger(0, 0, 60, 0)).state;
    const far = play(finger(0, 0, 150, 0)).state;
    expect(ball(far).z).toBeGreaterThan(ball(near).z);
  });

  it('cancels without a stroke when the pull ends inside the dead zone', () => {
    expect(pullBack(0, 0, 0)).toBeNull();
    expect(pullBack(0, MINIGOLF_PULL.deadZone * 0.6, MINIGOLF_PULL.deadZone * 0.6)).toBeNull();
    // Natáhne, nabije, pak se vrátí k míčku a pustí: nabití se zahodí, rána žádná.
    const back = play((tick) => (tick < 20 ? { aim: pullBack(0, 0, pullOf(30)), released: false } : { aim: pullBack(0, 4, 6), released: tick >= 25 }));
    expect(strokesOf(back.state)).toBe(0);
    expect(ball(back.state)).toMatchObject({ x: 0, z: -1000, vx: 0, vz: 0, charge: 0 });
    expect(back.log.some((event) => (event.buttons & BUTTON.TAP) !== 0)).toBe(false);
    // Puštění v mrtvé zóně bez nabití nepošle nic.
    expect(puttInput({ aim: null, released: true }, 0)).toEqual({ input: NO_INPUT, done: true });
    expect(puttInput({ aim: null, released: true }, 12)).toEqual({ input: { buttons: BUTTON.DOWN, axis: 0 }, done: true });
  });

  it('feeds the core the same input as the keyboard: HOLD with the aim per charge tick, then TAP', () => {
    for (const [dx, dy] of [[0, pullOf(25)], [-60, 80], [90, 40], [30, -120]] as const) {
      const aim = pullBack(0, dx, dy);
      expect(aim).not.toBeNull();
      const { axis, charge } = aim as { axis: number; charge: number };
      // Prst pustí hned po natažení (tik 0) – rána počká, až nabití dožene délku tahu.
      const touch = play(finger(0, dx, dy, 0));
      const keys = play(keyboard(axis, charge));
      expect(touch.log).toEqual(keys.log);
      expect(touch.log.filter((event) => event.buttons === BUTTON.HOLD)).toHaveLength(charge);
      expect(touch.log.every((event) => event.axis === axis)).toBe(true);
      expect(hashArcade(touch.state)).toBe(hashArcade(keys.state));
    }
  });

  it('lets the pull be shortened: the charge resets and builds up to the new length', () => {
    const { state, log } = play((tick) => ({ aim: pullBack(0, 0, tick < 45 ? pullOf(40) : pullOf(15)), released: tick >= 45 }));
    expect(log.some((event) => (event.buttons & BUTTON.DOWN) !== 0)).toBe(true);
    expect(strokesOf(state)).toBe(1);
    expect(ball(state).z - -1000).toBe(minigolfDistance(15));
  });

  it('finds the drag for a wanted aim and charge (finger of the e2e), the exact inverse of pullBack', () => {
    for (const base of [0, 250, -700, 1000]) {
      for (const [axis, charge] of [[0, 1], [120, 18], [-480, 33], [900, 60], [-1000, 7]] as const) {
        const { dx, dy } = pullFor(base, axis, charge);
        expect(pullBack(base, dx, dy)).toEqual({ axis: axis === -1000 ? 1000 : axis, charge });
      }
    }
  });

  it('turns the keyboard aim right with a positive step and wraps round behind the ball', () => {
    expect(turnAxis(0, 5)).toBe(5);
    expect(turnAxis(998, 5)).toBe(-997);
    expect(turnAxis(-998, -5)).toBe(997);
    // Krok doprava míří na obrazovce doprava: od +z k +x jádra (scéna zrcadlí x).
    expect(minigolfAim(turnAxis(0, 50))[0]).toBeGreaterThan(0);
  });
});
