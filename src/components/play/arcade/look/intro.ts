import { useEffect, useRef } from 'react';
import type { Camera, PerspectiveCamera, Quaternion, Vector3 } from 'three';

/**
 * Úvodní průlet (P28D T6, F-29; P37B T6): kamera přijíždí z širokého záběru
 * na kulisy k hernímu pohledu, ať hráč prostředí věty uvidí dřív, než se
 * začne dívat jen na hrdinu, a na konci lehce „dosedne“ (kousek přejede
 * k hrdinovi a vrátí se). Jen kamera – jádro, hash ani vstup o něm nevědí;
 * hra je ovladatelná od prvního snímku a první vstup průlet ukončí.
 *
 * P37B T6: 1,5 s bylo na hru, kterou jde hrát hned, moc – první vteřinu se
 * hráč díval na kulisy místo na hrdinu. Teď 0,9 s.
 */

export const INTRO_S = 0.9;
/** O kolik dál je kamera na začátku průletu (násobek vzdálenosti k bodu pohledu). */
const INTRO_PULL = 1.8;
/** O kolik metrů výš začíná. */
const INTRO_RISE = 4;
/** Přejezd při dosednutí (ease-out-back): 1 = nejbližší bod ~3,7 % průletu za herním pohledem. */
const INTRO_SETTLE = 1;

/**
 * Kolik průletu zbývá (1 = začátek, 0 = herní pohled, krátce pod nulou =
 * dosednutí blíž k hrdinovi). Ease-out-back: hráč brzy vidí hrdinu zblízka.
 */
export function introLeft(elapsed: number): number {
  const u = Math.min(1, Math.max(0, elapsed / INTRO_S)) - 1;
  if (u === 0) return 0;
  return -((INTRO_SETTLE + 1) * u ** 3 + INTRO_SETTLE * u ** 2);
}

/** Průlet, který `applyIntro` na kameru naposledy použil (`camera.userData.intro`): zbytek a bod pohledu. */
interface IntroMark {
  left: number;
  readonly look: [number, number, number];
}

/**
 * Posune už postavenou herní kameru po dráze průletu; `look` je bod, na který kamera míří.
 * Zbytek průletu a bod pohledu si kamera pamatuje – `restCamera` z nich vrátí herní pohled.
 */
export function applyIntro(camera: PerspectiveCamera, look: Vector3, left: number): void {
  const mark = (camera.userData.intro ??= { left: 0, look: [0, 0, 0] }) as IntroMark;
  mark.left = left;
  mark.look[0] = look.x;
  mark.look[1] = look.y;
  mark.look[2] = look.z;
  if (left === 0) return;
  camera.position.sub(look).multiplyScalar(1 + INTRO_PULL * left).add(look);
  camera.position.y += INTRO_RISE * left;
  camera.lookAt(look);
}

/** Zbytek průletu, který scéna na kameru naposledy použila (`introLeft`); 0 = herní pohled nebo scéna bez průletu. */
export function introLeftOf(camera: Camera): number {
  return (camera.userData.intro as IntroMark | undefined)?.left ?? 0;
}

/** Bod pohledu průletu, který `applyIntro` na kameru naposledy použil, do `out`. */
export function introLookOf(camera: Camera, out: Vector3): Vector3 {
  const mark = camera.userData.intro as IntroMark | undefined;
  return mark === undefined ? out : out.set(mark.look[0], mark.look[1], mark.look[2]);
}

/**
 * Herní kamera bez průletu (P54B T8): `out` dostane objektiv a polohu `camera`, a běží-li
 * průlet, polohu vrácenou na herní pohled – orientační bod se staví podle záběru hry, ne
 * podle širokého úvodu. Scéna bez průletu (střelnice, hod, rytmus…) kameru nechá, jak je.
 * P75 T4: kreslí-li se záběr zblízka v klidu (`RestShot`), vrátí herní záběr, který prolnul (`userData.game`).
 */
export function restCamera(camera: PerspectiveCamera, out: PerspectiveCamera): PerspectiveCamera {
  if (out.fov !== camera.fov || out.aspect !== camera.aspect || out.near !== camera.near || out.far !== camera.far) {
    out.fov = camera.fov;
    out.aspect = camera.aspect;
    out.near = camera.near;
    out.far = camera.far;
    out.updateProjectionMatrix();
  }
  out.up.copy(camera.up);
  const game = camera.userData.game as { readonly position: Vector3; readonly quaternion: Quaternion } | undefined;
  out.position.copy(game?.position ?? camera.position);
  out.quaternion.copy(game?.quaternion ?? camera.quaternion);
  if (game === undefined && introLeftOf(camera) !== 0) {
    const mark = camera.userData.intro as IntroMark;
    const [x, y, z] = mark.look;
    const pull = 1 + INTRO_PULL * mark.left;
    out.position.y -= INTRO_RISE * mark.left;
    out.position.set(x + (out.position.x - x) / pull, y + (out.position.y - y) / pull, z + (out.position.z - z) / pull);
    out.lookAt(x, y, z);
  }
  out.updateMatrixWorld();
  return out;
}

/**
 * Vteřiny od prvního snímku; po prvním vstupu hned konec průletu. Nástěnné
 * hodiny, ne `three.clock`: plátno po konci běhu přepne na `frameloop="demand"`
 * (P28E T2) a tím hodiny R3F vynuluje – průlet by se rozjel znovu a kamera
 * odjela 2,8× dál. Kamera je mimo hash, wall-clock tu smí.
 */
export function useIntroClock(): () => number {
  const start = useRef<number | null>(null);
  const done = useRef(false);
  useEffect(() => {
    const end = () => {
      done.current = true;
    };
    window.addEventListener('keydown', end, { once: true });
    window.addEventListener('pointerdown', end, { once: true });
    return () => {
      window.removeEventListener('keydown', end);
      window.removeEventListener('pointerdown', end);
    };
  }, []);
  return () => {
    if (done.current) return INTRO_S;
    const now = performance.now() / 1000;
    start.current ??= now;
    return now - start.current;
  };
}
