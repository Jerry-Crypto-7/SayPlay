'use client';

/**
 * `RepresentationSlot` — jediná cesta, kterou se slot dostane na scénu.
 *
 * Komponenta je schválně skoro prázdná a je to celý její smysl. Obal, jeho
 * transformace, sockety i výměna podoby bydlí v `representation.ts`, takže
 * tady nezbývá než ten obal vykreslit. **Kdyby uměla připojit mesh sama,
 * existovaly by dvě cesty, jak se podoba dostane na scénu** — a ta druhá by
 * neuměla nic z toho, co §13.2 při výměně vyžaduje: nekoukala by na revizi,
 * nezkontrolovala kvádr a starou podobu by neodložila.
 *
 * Proto se sem `Object3D` z workeru **nepředává**. Vstup je `SlotView`, tedy
 * to, co registry už rozhodlo, a `<primitive>` je jen připnutí hotového uzlu
 * do React stromu.
 *
 * ## Proč `primitive` a ne `<group>` s potomky
 *
 * Uzly obalu vznikají a mizí mimo React — dorazí z workeru, prohrají závod,
 * odloží se. Nechat React, aby ten strom skládal z JSX, znamená mít o něm
 * druhou pravdu, která se s registry rozejde přesně ve chvíli, kdy se dvě
 * výměny potkají v jednom snímku. `primitive` říká „tenhle uzel spravuje
 * někdo jiný", což je přesně tenhle případ.
 */

import type { SlotView } from './representation';

export interface RepresentationSlotProps {
  readonly view: SlotView;
}

export function RepresentationSlot({ view }: RepresentationSlotProps): React.ReactElement {
  // `key` je `stableId`, ne revize: obal má výměnu **přežít**, takže ho React
  // nesmí při zvednutí revize odpojit a založit znovu.
  return <primitive object={view.group} />;
}

export interface RepresentationSlotsProps {
  readonly views: readonly SlotView[];
}

/** Všechny sloty světa. Pořadí je pořadí blueprintu. */
export function RepresentationSlots({ views }: RepresentationSlotsProps): React.ReactElement {
  return (
    <>
      {views.map((view) => (
        <RepresentationSlot key={view.stableId} view={view} />
      ))}
    </>
  );
}
