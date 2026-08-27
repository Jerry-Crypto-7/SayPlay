/**
 * Dopočet poloh mezi dvěma tiky.
 *
 * Simulace běží na pevných 20 Hz a poloha entity je odvozená z **celočíselné
 * buňky** (`projection.ts`), takže bez dopočtu postava dvacetkrát za sekundu
 * skočí o celé pole. Tenhle soubor je jediné místo, kde se mezi dvěma tiky něco
 * dopočítává.
 *
 * **Nic odsud nesmí vtéct do hashovaného stavu.** Vstupem jsou dvě hotové
 * projekce, výstupem třetí — runtime se nečte ani nemění a `three` se sem
 * neimportuje. Zlomek tiku je nástěnná veličina a ta na replay cestě nesmí
 * existovat vůbec (`CLAUDE.md`, Determinismus). Proto se to celé dá ověřit
 * v Node bez GPU.
 *
 * **Nespojité údaje se berou ze staršího tiku, ne z novějšího.** Poloha se
 * dopočítává mezi tikem N−1 a N, takže obraz jako celek je o jeden tik pozadu;
 * kdyby se `active` a `state` braly z N, sebraná mince by zmizela ve chvíli, kdy
 * postava teprve doklouzává na její pole. Zpoždění je jednotné, ne rozházené.
 */

import type { ProjectedEntity, Vec3 } from './projection';

function lerp(from: Vec3, to: Vec3, alpha: number): Vec3 {
  return {
    x: from.x + (to.x - from.x) * alpha,
    y: from.y + (to.y - from.y) * alpha,
    z: from.z + (to.z - from.z) * alpha,
  };
}

/**
 * Hnul se mezi dvěma tiky někdo?
 *
 * Porovnává se **jen poloha**, ne stav ani zámek: dopočítává se poloha, takže
 * tik, ve kterém se otevřely dveře, ale nikdo neušel ani krok, žádnou mezipolohu
 * nemá. Různě dlouhá pole znamenají, že se změnilo složení světa — to je pohyb
 * v tom smyslu, o který tu jde.
 */
function moves(prev: readonly ProjectedEntity[], next: readonly ProjectedEntity[]): boolean {
  if (prev.length !== next.length) return true;

  for (let at = 0; at < next.length; at += 1) {
    const from = prev[at].position;
    const to = next[at].position;
    if (prev[at].stableId !== next[at].stableId) return true;
    if (from.x !== to.x || from.y !== to.y || from.z !== to.z) return true;
  }

  return false;
}

/**
 * Projekce ve zlomku `alpha` cesty z `prev` do `next`.
 *
 * `alpha <= 0` vrací starší tik beze změny, `alpha >= 1` novější — obojí je
 * potřeba: `step(n)` z `window.__viewer` posune běh bez nástěnného času a musí
 * ukázat přesný stav po tiku, ne rozmazaný mezistav.
 *
 * Pořadí i délka se drží podle `next`, protože to je pole, které kreslení čeká
 * (deklarační pořadí a plná délka, viz `projectEntities`). Entita, kterou starší
 * tik nezná, se kreslí rovnou na své nové místo — přiletět odněkud, kde nikdy
 * nebyla, je horší vada než objevit se o tik dřív.
 */
export function interpolateEntities(
  prev: readonly ProjectedEntity[],
  next: readonly ProjectedEntity[],
  alpha: number,
): readonly ProjectedEntity[] {
  // Zápis přes negaci schválně: `NaN` sem spadne taky a znamená „ještě nic
  // neuběhlo", ne „dopočítej neznámo kam".
  if (!(alpha > 0)) return prev;
  if (alpha >= 1) return next;
  // Dohraný svět má obě projekce tytéž a snímky běží dál. Bez téhle zkratky by
  // se každý z nich přepočítával na týž výsledek — a je jich po dohrání nejvíc.
  if (prev === next) return next;
  // **Tik, ve kterém se nikdo nehnul, nemá co dopočítávat** — a takových je ve
  // zmrazených světech většina: postavou hýbe jen tah `moveTo` a těch je ve
  // svědkovi pár. Vrací se starší tik, tedy táž hodnota jako minule, takže na ní
  // vykreslení pozná, že přepisovat matice a posílat je na GPU nemusí. Bez toho
  // stálo dopočítávání celý snímek i ve světě, kde se nic nedělo — naměřeno
  // 27. 8. 2026 na `e2e/camera.spec.ts`, které kvůli tomu přestalo stíhat.
  if (!moves(prev, next)) return prev;

  const before = new Map(prev.map((entity) => [entity.stableId, entity]));

  return next.map((entity) => {
    const from = before.get(entity.stableId);
    if (from === undefined) return entity;
    return { ...from, position: lerp(from.position, entity.position, alpha) };
  });
}
