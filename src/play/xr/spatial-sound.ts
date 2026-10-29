/**
 * Prostorový zvuk ve VR (P67 T8). Zvuk události sběrnice zní z místa, kde scéna tělo kreslí, a posluchač je hlava.
 * `XrAudio` dosadí `route` do `spatial.route` v `@/play/audio` jen po dobu relace s hrou; mimo VR se modul ani
 * nestáhne (chunk XR). Zvuk bez polohy jde rovnou do `destination`, takže jeho výstup je bajt po bajtu stejný.
 * Poloha zvuku i hlava jsou jen kresba: do hashovaného stavu nejde nic.
 */

import { type Matrix4, Vector3 } from 'three';

import { SFX_REPEAT_MS, type SoundAt } from '@/play/audio';

import type { Point } from './diorama-scale';

/** Ohyb trati běžce ve scéně (`runnerPathOf`); `null` = rovný svět. */
export type Bend = ((z: number) => { readonly x: number; readonly y: number }) | null;

/**
 * Bod události (m, osy jádra) → bod ve skutečném prostoru (m, `local-floor`). Scéna kreslí tělo v (−x, y, z), na
 * trati běžce posunuté o ohyb (jako částice v `Effects`). Matice obalu světa (`world`) pak nese režim rigu: desku
 * dioramy, svět kolem hráče (`room`), nebo svět VR-nativního žánru.
 */
export function soundPointOf(at: SoundAt, world: Matrix4, bend: Bend, out = new Vector3()): Vector3 {
  const curve = bend?.(at.z);
  return out.set((curve?.x ?? 0) - at.x, at.y + (curve?.y ?? 0), at.z).applyMatrix4(world);
}

/**
 * Panner: HRTF (směr i výška vůči hlavě), útlum `inverse`. Do 1 m plná hlasitost, dál ubývá pomalu (0,3), ať je
 * zásah na kraji arény (8 m, ~32 %) i daleko ve střílečce (20 m, ~15 %) pořád slyšet. Diorama je celá do metru.
 */
export const PANNER = { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0.3 } as const;

/** Hlava ze snímku: poloha a směry pohledu a temene (jednotkové). */
export interface Head {
  readonly position: Point;
  readonly forward: Point;
  readonly up: Point;
}

/** Co o zvuku ve VR čte e2e (`window.__playXrSound`). */
export interface SpatialReport {
  /** Kolik zvuků zaznělo přes panner. */
  readonly placed: number;
  /** Kde zazněl poslední (m, `local-floor`). */
  readonly last: Point | null;
  /** Kde je posluchač (hlava z posledního snímku); `null` = ještě nic nezaznělo nebo hlava chybí. */
  readonly listener: Point | null;
}

export interface SpatialSound {
  /** Pro `spatial.route` v `@/play/audio`. */
  readonly route: (context: AudioContext, source: AudioBufferSourceNode, at?: SoundAt) => void;
  /** Hlava z tohoto snímku; posluchač kontextu ji dostane hned, jakmile nějaký zvuk zazněl. */
  hear(head: Head): void;
  report(): SpatialReport;
}

/**
 * `world` vrátí aktuální matici obalu světa (`null` = obal ještě není, zvuk pak zní bez polohy).
 *
 * Efekty jádra ohlásí sebrání, zásah, výhru i prohru dřív než sběrnice (posluchač relace z `ArcadePlay` je první)
 * a zvuk bez polohy už hraje. Týž zvuk s polohou z téhož tiku ho proto utne – ještě v téže úloze, než cokoli zaznělo.
 */
export function createSpatialSound(world: () => Matrix4 | null, bend: Bend): SpatialSound {
  let context: AudioContext | null = null;
  let head: Head | null = null;
  let placed = 0;
  let last: Point | null = null;
  const point = new Vector3();
  /** Poslední zvuk bez polohy podle bufferu (buffer = preset), s časem kontextu. */
  const plain = new Map<AudioBuffer, { readonly source: AudioBufferSourceNode; readonly at: number }>();

  const listen = (): void => {
    if (context === null || head === null) return;
    const { listener } = context;
    const { position: p, forward: f, up: u } = head;
    // Gecko (Wolvic) nemá parametry posluchače, jen starší volání.
    if (!('positionX' in listener)) {
      (listener as AudioListener).setPosition(p.x, p.y, p.z);
      (listener as AudioListener).setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    } else {
      listener.positionX.value = p.x;
      listener.positionY.value = p.y;
      listener.positionZ.value = p.z;
      listener.forwardX.value = f.x;
      listener.forwardY.value = f.y;
      listener.forwardZ.value = f.z;
      listener.upX.value = u.x;
      listener.upY.value = u.y;
      listener.upZ.value = u.z;
    }
  };

  return {
    route(ctx, source, at) {
      if (context !== ctx) {
        context = ctx;
        listen();
      }
      const { buffer } = source;
      const matrix = at === undefined ? null : world();
      if (at === undefined || matrix === null) {
        source.connect(ctx.destination);
        if (buffer !== null) plain.set(buffer, { source, at: ctx.currentTime });
        return;
      }
      const twin = buffer === null ? undefined : plain.get(buffer);
      if (twin !== undefined && ctx.currentTime - twin.at < SFX_REPEAT_MS / 1000) {
        twin.source.stop();
        plain.delete(buffer!);
      }
      soundPointOf(at, matrix, bend, point);
      const panner = ctx.createPanner();
      panner.panningModel = PANNER.panningModel;
      panner.distanceModel = PANNER.distanceModel;
      panner.refDistance = PANNER.refDistance;
      panner.rolloffFactor = PANNER.rolloffFactor;
      panner.positionX.value = point.x;
      panner.positionY.value = point.y;
      panner.positionZ.value = point.z;
      source.connect(panner);
      panner.connect(ctx.destination);
      source.addEventListener('ended', () => panner.disconnect());
      placed += 1;
      last = { x: point.x, y: point.y, z: point.z };
    },
    hear(next) {
      head = next;
      listen();
    },
    report: () => ({ placed, last, listener: context === null || head === null ? null : { x: head.position.x, y: head.position.y, z: head.position.z } }),
  };
}
