/**
 * Popisek jména na plátně (P58A T5): „Cat“ nad hrdinou, pak „Crocodile“ nad nejbližším
 * tělem, které věta jmenuje – každé 1,5 s po řádku se slovesem, nikdy spolu. Štítek kitu
 * `sp-world-tag` ve slunečné variantě jako řádek se slovesem (rajčatová patří jediné akci
 * obrazovky); polohu (a jméno těla) mu každý snímek píše `NameAnchor` ve stage, do té doby
 * je schovaný. Klip porotce HTML skrývá, popisek je pro lidi.
 */

import type { NameSlot } from './name-line';

export function NameLine({ slot, hero }: { readonly slot: NameSlot; readonly hero: string | null }) {
  return (
    <p className="sp-world-tag sp-world-tag--goal play-name-line" data-testid="play-name-line" data-slot={slot} aria-hidden="true">
      {slot === 'hero' ? hero : null}
    </p>
  );
}
