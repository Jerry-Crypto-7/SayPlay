'use client';

/**
 * **Materializace — detail dorazí, ale neproblikne** (P15 T20, design book §14).
 *
 * Hrubá podoba je nepálená hlína. Když doběhne mesh ve vyšším rozlišení, nesmí
 * se objevit střihem: „význam se nejdřív projeví jako prostorová kostra, potom
 * jako hmota" (§14). Tenhle soubor je ten přechod, a je schválně ten nejnižší
 * ze tří implementačních stupňů §14 — **crossfade v jednom slotu**. Reveal
 * rovina a lokální SDF shell jsou stupně 2 a 3 a nepřidávají se.
 *
 * ## Kandidát se odkrývá, hrubá podoba se nezatmívá
 *
 * Nabízí se protisměrný přechod: kandidát 0 → 1, hlína 1 → 0. Nedělá se, a je
 * to měřitelný důvod, ne vkus. Uprostřed takového přechodu má součet krytí
 * hodnotu **pod jedničkou** — na půl vteřiny je vidět skrz objekt na pozadí,
 * a přesně tenhle propad čte oko jako záblesk. Hlína proto zůstane celou dobu
 * neprůhledná a kandidát se odkrývá **nad ní**; v poslední chvíli ji `commit()`
 * odpojí, když už ji stejně není vidět.
 *
 * Vedlejší zisk je poctivější: **na hrubou podobu se vůbec nesahá.** Kdyby se
 * jí měnilo krytí a odhalení se v půlce zruší (§13.3 bod 7), zůstala by
 * poloprůhledná — tedy scéna hůř, než jak vypadala před pokusem o zlepšení.
 *
 * ## Čas je čas renderu, nikdy simulační tik
 *
 * `Assembly.tsx` odhaluje svět podle `clock.tick`, protože ta stavba **je**
 * součástí světa a musí být deterministická při replayi. Tady je to opačně:
 * materializace je podívaná, ne stav. `CLAUDE.md` jmenuje kameru, tweeny a
 * postprocessing jako věci, které musí zůstat mimo hashovaný stav, a odhalení
 * patří mezi ně. Bere proto `delta` z `useFrame`, tedy nástěnný čas rendereru,
 * a na běh simulace nemá vliv žádný.
 *
 * ## Tlumený pohyb není zkrácené odhalení, je to žádné
 *
 * Totéž pravidlo jako v `Assembly.tsx`: při `prefers-reduced-motion: reduce`
 * je detail vidět od prvního snímku. Skončí to **týmž** stavem scény, ne
 * horším — jeden `commit()`, jedna podoba, tytéž sockety.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Material, Object3D } from 'three';

import { prefersReducedMotion } from './Assembly';

/**
 * Jak dlouho odhalení trvá.
 *
 * Design book §11 dává hrubé podobě rozpočet 350 ms a jemné 2 600 ms, takže
 * odhalení musí být řádově kratší než čekání na mesh — jinak by se stalo tím,
 * na co se čeká. 700 ms je zhruba dvojnásobek doby, po kterou oko změnu
 * povrchu registruje jako pohyb, a zlomek nejbližšího čekání.
 */
export const MATERIALIZE_MS = 700;

export interface RevealPlan {
  /** Nula znamená „hned a celé", ne „bez odhalení". */
  readonly durationMs: number;
  readonly reducedMotion: boolean;
  /** Krytí kandidáta. Hrubá podoba svoje nemění, viz hlavička. */
  opacityAt(elapsedMs: number): number;
  done(elapsedMs: number): boolean;
}

export interface RevealOptions {
  readonly reducedMotion?: boolean;
  readonly durationMs?: number;
}

/**
 * Rozvrh odhalení. **Čistá funkce** — testuje se bez prohlížeče a bez plátna.
 *
 * Krytí je lineární schválně. Náběhová křivka (`smoothstep`) by tady byla
 * ozdoba, kterou nikdo neobjednal, a hlavně by se hůř soudila: u lineárního
 * průběhu je „v půlce je krytí 0,5" tvrzení, které jde napsat do testu.
 */
export function createRevealPlan(options: RevealOptions = {}): RevealPlan {
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  const durationMs = reducedMotion ? 0 : (options.durationMs ?? MATERIALIZE_MS);

  return {
    durationMs,
    reducedMotion,
    opacityAt: (elapsedMs) => {
      if (durationMs <= 0 || elapsedMs >= durationMs) return 1;
      return elapsedMs <= 0 ? 0 : elapsedMs / durationMs;
    },
    done: (elapsedMs) => elapsedMs >= durationMs,
  };
}

/* ------------------------------------------------------------------ *
 * Krytí na celém podstromu.
 * ------------------------------------------------------------------ */

interface Renderable extends Object3D {
  material?: Material | Material[];
}

function materialsOf(object: Object3D): Material[] {
  const material = (object as Renderable).material;
  if (material === undefined) return [];
  return Array.isArray(material) ? material : [material];
}

/**
 * Nastaví krytí celému podstromu kandidáta.
 *
 * `transparent` se zapíná jen po dobu odhalení a na konci se **vypíná zpátky**:
 * průhledný materiál se v three řadí do jiného průchodu a kreslí se bez zápisu
 * do hloubky, takže hotová podoba, které by příznak zůstal, by se s okolím
 * překrývala jinak než hrubá, kterou nahradila. Pop-in by zmizel a vyměnil se
 * za tichou vadu řazení.
 */
export function applyReveal(root: Object3D, opacity: number): void {
  const done = opacity >= 1;
  root.traverse((object) => {
    for (const material of materialsOf(object)) {
      material.transparent = !done;
      material.opacity = done ? 1 : opacity;
      material.depthWrite = true;
      material.needsUpdate = true;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Komponenta.
 * ------------------------------------------------------------------ */

export interface MaterializeProps {
  /** Kandidát, kterého registry připojilo neviditelného (§13.3 bod 4). */
  readonly object: Object3D;
  readonly plan: RevealPlan;
  /** Odhalení doběhlo — volající má zavolat `registry.commit()`. */
  readonly onDone: () => void;
}

/**
 * Nevykresluje nic. Jen posouvá krytí jednoho kandidáta v čase renderu.
 *
 * Je to komponenta, a ne obyčejná funkce, právě kvůli `useFrame`: R3F posílá
 * `delta` jen tomu, kdo je ve stromu plátna, a odhalení se musí zastavit ve
 * chvíli, kdy plátno přestane kreslit — jinak by na skryté záložce doběhlo
 * v jednom skoku, tedy jako pop-in.
 */
export default function Materialize({ object, plan, onDone }: MaterializeProps): null {
  const elapsed = useRef(0);
  const finished = useRef(false);

  useEffect(() => {
    elapsed.current = 0;
    finished.current = false;
    // Kandidát je do téhle chvíle neviditelný. Zviditelní se s krytím prvního
    // snímku, ne s plným — jinak by první snímek byl přesně ten střih.
    applyReveal(object, plan.opacityAt(0));
    object.visible = true;
  }, [object, plan]);

  useFrame((_state, delta) => {
    if (finished.current) return;

    elapsed.current += delta * 1000;
    applyReveal(object, plan.opacityAt(elapsed.current));

    if (plan.done(elapsed.current)) {
      finished.current = true;
      onDone();
    }
  });

  return null;
}
