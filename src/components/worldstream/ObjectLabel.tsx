'use client';

/**
 * **Kotvený popisek vybraného objektu** (P15 T23, design book §4 dějství III).
 *
 * Porotce klikne do světa a musí okamžitě vidět, **který objekt teď drží** —
 * jinak by druhá věta mířila naslepo. Popisek proto visí u objektu a jde s ním:
 * když se kamera pohne nebo se objekt vymění za jemnější podobu, jméno zůstane
 * na svém místě nad ním.
 *
 * ## Proč se popisek nekreslí uvnitř plátna
 *
 * Nabízí se `<Html>` z drei nebo sprite ve scéně. Obojí je horší:
 *
 *  - **Sprite ve scéně** dědí osvětlení, mlhu a hloubku, takže by ho svět mohl
 *    zastínit — a popisek, který se schová za kopcem, je popisek k ničemu.
 *  - **`<Html>` z drei** táhne barrel `@react-three/drei`, který podle
 *    `CLAUDE.md` importuje `@mediapipe/tasks-vision` a `hls.js`. Za jeden
 *    absolutně pozicovaný `<div>` je to nepřijatelná cena.
 *
 * Popisek je tedy obyčejné DOM a leží nad plátnem.
 *
 * ## Pozici píše stage, ne React
 *
 * Kdyby se souřadnice předávala propem, znamenal by každý snímek `setState`
 * a překreslení celé skořápky — šedesátkrát za vteřinu, kvůli dvěma číslům.
 * Místo toho si `WorldstreamStage` bere **ref na tenhle uzel** a v `useFrame`
 * mu rovnou přepíše `transform`. React se o pohybu nedozví a nemá proč.
 *
 * Uzel proto **zůstává v DOM i mimo obraz** a schovává ho `visibility`, kterou
 * píše taky stage. Odpojit ho by znamenalo ref, který za pohybu kamery střídavě
 * mizí, a stage by neměla kam psát.
 *
 * ## Popisek je jméno pro člověka
 *
 * Píše se `label` ze `SemanticObject` (*„the tallest hive"*), nikdy `stableId`
 * (`tallHive`). `stableId` je adresa pro stroj; kdyby ji četl porotce, mluvil by
 * na produkt jeho jazykem místo obráceně. Do DOM jde jako `data-stable-id`, aby
 * se testy měly čeho chytit.
 */

import type { RefObject } from 'react';

export interface ObjectLabelProps {
  /** Jméno objektu pro člověka. */
  readonly label: string;
  /** Adresa objektu pro stroj. Jde jen do atributu, nikdy do textu. */
  readonly stableId: string;
  /** Uzel, kterému stage každý snímek přepisuje `transform` a `visibility`. */
  readonly anchor: RefObject<HTMLDivElement | null>;
}

export default function ObjectLabel({
  label,
  stableId,
  anchor,
}: ObjectLabelProps): React.ReactElement {
  return (
    <div
      ref={anchor}
      className="ws-object-label"
      data-testid="object-label"
      data-stable-id={stableId}
      /* Dokud stage nenapsala první polohu, popisek nesmí bliknout v rohu.
         `hidden` by ho odpojil z rozvržení a stage by neměla co posouvat. */
      style={{ visibility: 'hidden' }}
    >
      {label}
    </div>
  );
}
