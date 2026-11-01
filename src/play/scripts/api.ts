/**
 * API skriptu úrovně (P68 T13, pilot za `PLAY_SCRIPTS`): co smí `build(api)` v sandboxu QuickJS volat.
 *
 * Všechno nad celými čísly: `api.place(kind, cellX, cellZ)` položí věc uzavřeného seznamu hry na pole mřížky,
 * `api.path(points)` lomenou čáru polí `[[x, z], …]`, `api.rng.int(a, b)` celé číslo z `[a, b]` z hostitelského
 * `pure-rand` se semínkem hry (jiná náhoda ve VM není – `Date` a `Math.random` sandbox maže), `api.param(name)`
 * parametr hry. Záznam volání je surový výstup skriptu; data úrovně z něj staví a meze hlídá `validate.ts`.
 *
 * Hostitelská strana je čistá: žádné QuickJS, takže ji testy i laboratorní stránka volají bez VM.
 */

import { createCompileRng } from '@/play/compile/rng';

/** Hry, pro které skript píše, s uzavřeným seznamem `kind` a parametry, které `api.param` vydá. */
export const SCRIPT_GAMES = {
  hop: { kinds: ['road', 'river', 'rail'], params: ['rows'] },
} as const;
export type ScriptGame = keyof typeof SCRIPT_GAMES;

/** Meze záznamu: kolik volání skript smí, než ho API zastaví (výstup, ne výpočet – ten hlídá rozpočet sandboxu). */
export const SCRIPT_LIMITS = {
  places: 256,
  paths: 16,
  pathPoints: 64,
  /** Souřadnice pole a meze `rng.int` v absolutní hodnotě. */
  coord: 1 << 20,
  rng: 1 << 30,
} as const;

/** Salt streamu náhody skriptu: vlastní stream nad semínkem hry, oddělený od rozvržení úrovně. */
const RNG_SALT = 0x7a5e;

export interface ScriptRecording {
  /** `[kind, cellX, cellZ]` v pořadí volání. */
  readonly places: (readonly [string, number, number])[];
  readonly paths: (readonly (readonly [number, number])[])[];
  /** Kolik čísel skript vylosoval (`api.rng.int`). */
  draws: number;
}

/** Chyba volání API: sandbox ji vyhodí uvnitř VM jako `Error` a běh skončí jako `thrown`. */
export class ScriptApiError extends Error {}

export interface ScriptHost {
  readonly recording: ScriptRecording;
  place(kind: unknown, x: unknown, z: unknown): void;
  path(points: unknown): void;
  rngInt(a: unknown, b: unknown): number;
  param(name: unknown): number;
}

const int = (value: unknown, what: string, bound: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > bound) throw new ScriptApiError(`${what} must be an integer within ±${bound}, got ${String(value)}`);
  return value;
};

/** Hostitel jednoho běhu: záznam volání, stream náhody ze semínka a parametry hry. */
export function createScriptHost(game: ScriptGame, params: Readonly<Record<string, number>>, seed: number): ScriptHost {
  const { kinds, params: names } = SCRIPT_GAMES[game];
  const rng = createCompileRng(seed ^ RNG_SALT);
  const recording: ScriptRecording = { places: [], paths: [], draws: 0 };
  return {
    recording,
    place(kind, x, z) {
      if (typeof kind !== 'string' || !(kinds as readonly string[]).includes(kind)) throw new ScriptApiError(`place: kind must be one of ${kinds.join(', ')}, got ${String(kind)}`);
      if (recording.places.length >= SCRIPT_LIMITS.places) throw new ScriptApiError(`place: at most ${SCRIPT_LIMITS.places} calls`);
      recording.places.push([kind, int(x, 'place: cellX', SCRIPT_LIMITS.coord), int(z, 'place: cellZ', SCRIPT_LIMITS.coord)]);
    },
    path(points) {
      if (recording.paths.length >= SCRIPT_LIMITS.paths) throw new ScriptApiError(`path: at most ${SCRIPT_LIMITS.paths} calls`);
      if (!Array.isArray(points) || points.length < 2 || points.length > SCRIPT_LIMITS.pathPoints) throw new ScriptApiError(`path: points must be an array of 2..${SCRIPT_LIMITS.pathPoints} [x, z] pairs`);
      recording.paths.push(
        points.map((point: unknown, index): readonly [number, number] => {
          if (!Array.isArray(point) || point.length !== 2) throw new ScriptApiError(`path: point ${index} must be [x, z]`);
          return [int(point[0], `path: point ${index} x`, SCRIPT_LIMITS.coord), int(point[1], `path: point ${index} z`, SCRIPT_LIMITS.coord)];
        }),
      );
    },
    rngInt(a, b) {
      const from = int(a, 'rng.int: a', SCRIPT_LIMITS.rng);
      const to = int(b, 'rng.int: b', SCRIPT_LIMITS.rng);
      if (from > to) throw new ScriptApiError(`rng.int: a (${from}) must not exceed b (${to})`);
      recording.draws += 1;
      return rng.int(from, to);
    },
    param(name) {
      if (typeof name !== 'string' || !(names as readonly string[]).includes(name) || params[name] === undefined) throw new ScriptApiError(`param: one of ${names.join(', ')}, got ${String(name)}`);
      return params[name];
    },
  };
}
