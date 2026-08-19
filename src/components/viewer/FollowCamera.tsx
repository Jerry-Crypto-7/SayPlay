'use client';

/**
 * Kamera, která jde za postavou.
 *
 * **Dojíždí po tikách, ne po snímcích.** Kamera je sice jediná věc, která by si
 * nástěnný čas dovolit mohla — leží mimo hashovaný stav, takže na determinismus
 * běhu nedosáhne — ale kdyby se řídila snímky, nešla by ověřit: `step(100)`
 * posune svět bez čekání na skutečný čas a kamera by za ním zůstala o sto
 * pohybů pozadu. Tady se místo toho spočítá, kolik tiků od minulého snímku
 * uběhlo, a tolikrát se dojede. Rychlý stroj i pomalý stroj tak skončí na téže
 * pozici.
 *
 * Vzdálenost od postavy je celý smysl téhle úlohy, takže se drží dvěma věcmi
 * najednou: pevným odstupem, ke kterému se míří, a dost rychlým dojezdem, aby
 * zpoždění za běžící postavou nepřerostlo pásmo, ve kterém je scéna čitelná.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';

import type { ProjectedEntity, Vec3 } from './projection';
import type { RunnerRef } from './WorldScene';

/**
 * Odstup kamery od postavy.
 *
 * Míří se **nad a za** postavu, ne do její roviny: pohled shora dopředu ukáže
 * mřížku, po které se hraje, a přitom nechá vidět, kam postava kouká. Délka
 * odstupu (≈ 9,6) je schválně uprostřed pásma, ve kterém má vzdálenost zůstat —
 * z prostředku má dojezd stejnou rezervu na obě strany.
 */
export const FOLLOW_OFFSET: Vec3 = { x: 0, y: 6, z: 7.5 };

/**
 * Kolik zbývající vzdálenosti kamera ujede za jeden tik.
 *
 * Není to kosmetika, je to ta hodnota, která drží spodní i horní mez. Při
 * plynulém dojezdu se ustálené zpoždění za postavou jdoucí stálou rychlostí
 * rovná `(1 − α) / α` políčka, tedy tady necelá dvě. Odstup ≈ 9,6 ± 2 zůstává
 * pohodlně uvnitř pásma; kdyby byl dojezd o hodně línější, samotné zpoždění by
 * se z pásma vysunulo, i kdyby byl odstup nastavený správně.
 */
export const FOLLOW_ALPHA = 0.35;

/** Kam kamera míří, když postava stojí na `at`. */
export function desiredPosition(at: Vec3): Vec3 {
  return { x: at.x + FOLLOW_OFFSET.x, y: at.y + FOLLOW_OFFSET.y, z: at.z + FOLLOW_OFFSET.z };
}

/** Jeden tik dojezdu. Čistá funkce, aby šla ověřit bez plátna i bez GPU. */
export function easeToward(from: Vec3, to: Vec3, alpha = FOLLOW_ALPHA): Vec3 {
  return {
    x: from.x + (to.x - from.x) * alpha,
    y: from.y + (to.y - from.y) * alpha,
    z: from.z + (to.z - from.z) * alpha,
  };
}

/**
 * Postava, kterou kamera sleduje.
 *
 * Přednost má živá postava; despawnutá se bere až jako druhá volba, aby kamera
 * neodletěla ve chvíli, kdy hra postavu na jeden tik odstraní. Svět bez postavy
 * (třídění do soketů se hraje ukazováním) vrací `null` a kamera se pak nehýbe —
 * je to poctivá odpověď, ne chybějící údaj.
 */
export function avatarOf(entities: readonly ProjectedEntity[]): ProjectedEntity | null {
  const avatars = entities.filter((entity) => entity.visual === 'avatar');
  return avatars.find((entity) => entity.active) ?? avatars[0] ?? null;
}

export default function FollowCamera({ runnerRef }: { readonly runnerRef: RunnerRef }) {
  const camera = useThree((state) => state.camera);
  // `null` znamená „kamera ještě nikoho nesleduje". První sledovaný tik se
  // proto nedojíždí, ale skočí: dojezd z výchozí pozice plátna by prvních pár
  // tiků strávil mimo pásmo, ve kterém má vzdálenost zůstat.
  const at = useRef<Vec3 | null>(null);
  const lastTick = useRef(0);

  useFrame(() => {
    const runner = runnerRef.current;
    if (runner === null) {
      at.current = null;
      lastTick.current = 0;
      return;
    }

    const avatar = avatarOf(runner.entities());
    if (avatar === null) return;

    const tick = runner.tick();
    const elapsed = Math.max(0, tick - lastTick.current);
    lastTick.current = tick;

    // Dokud svět běží, dojíždí se po tikách. Až doběhne — výhrou nebo prohrou —
    // se tik zastaví, a kdyby se kamera řídila jen jím, zůstala by trčet přesně
    // tam, kde ji poslední tik zastihl: naměřeno 19. 8. 2026, kamera dosedla o
    // 0,23 políčka vedle a už se nehnula. Po konci partie se proto dojíždí po
    // snímcích. Nic to nerozbíjí — po konci se svět nemění, takže tady žádná
    // veličina, na kterou by se kdokoli ptal, na snímcích viset nezačne.
    const steps = runner.runState() === 'running' ? elapsed : 1;

    const target = desiredPosition(avatar.position);
    if (at.current === null) {
      at.current = target;
    } else {
      // Tolikrát, kolik tiků uběhlo — ne jednou za snímek. Sto tiků odkrokovaných
      // najednou tak dojede stejně daleko jako sto tiků odtikaných v reálném čase.
      let next = at.current;
      for (let i = 0; i < steps; i += 1) next = easeToward(next, target);
      at.current = next;
    }

    camera.position.set(at.current.x, at.current.y, at.current.z);
    camera.lookAt(avatar.position.x, avatar.position.y, avatar.position.z);
  });

  return null;
}
