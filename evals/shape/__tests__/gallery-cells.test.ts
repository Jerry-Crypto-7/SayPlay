/**
 * Stojí kus pod svým vlastním popiskem? (P13 vlna 1, `T7-labels`)
 *
 * Stránka `/gallery` kreslí dvanáct **pevných** buněk s popisky z celé galerie,
 * ale kusy do nich sází po jednom, jak dojdou z meshovací fronty. Dokud se
 * buňka počítala z délky hotového pole, každé selhání posunulo celý zbytek
 * o buňku doleva — pod cizí jméno.
 *
 * **Naměřeno 31. 8. 2026**, headless běh nad `/gallery`: `root`, `shell`
 * a `column` přetáhly rozpočet meshingu, prošlo devět tvarů z dvanácti, a kotel
 * stál pod popiskem `Column`, síť pod `Cauldron`. Brána K1 se přitom soudí okem
 * nad tou stránkou, takže by člověk rozhodoval o tvarech pod cizími jmény.
 *
 * Selhání meshingu se tu **nezakazuje** — je to legitimní stav a stránka ho
 * vypisuje. Tvrdí se jen to, že zbylé kusy zůstanou na svém místě.
 */

import { describe, expect, it } from 'vitest';

import { GALLERY, GALLERY_IDS, galleryIndex } from '../gallery';

/** Tři tvary, které v naměřeném běhu propadly na rozpočtu meshingu. */
const MEASURED_FAILURES = ['root', 'shell', 'column'] as const;

describe('gallery cells', () => {
  it('gives every shape the cell its own label sits in', () => {
    // Popisky se kreslí `GALLERY.map(...)`, takže buňka popisku JE index v poli.
    for (const [cell, item] of GALLERY.entries()) {
      expect(galleryIndex(item.id)).toBe(cell);
    }
  });

  it('keeps the survivors in place when three shapes fail to mesh', () => {
    const survivors = GALLERY.filter(
      (item) => !MEASURED_FAILURES.includes(item.id as (typeof MEASURED_FAILURES)[number]),
    );
    expect(survivors).toHaveLength(GALLERY.length - MEASURED_FAILURES.length);

    // Tohle je ta vada: pořadí ve zkráceném poli není buňka. Kotel je devátý
    // v galerii, ale šestý mezi tím, co došlo — a šestá buňka nese `Column`.
    const byArrivalOrder = survivors.map((item) => item.id);
    expect(byArrivalOrder.indexOf('cauldron')).toBe(5);
    expect(GALLERY_IDS[5]).toBe('column');

    for (const item of survivors) {
      expect(GALLERY_IDS[galleryIndex(item.id)]).toBe(item.id);
    }
  });

  it('refuses a shape the gallery does not have', () => {
    expect(() => galleryIndex('leviathan')).toThrow(/gallery has no shape leviathan/);
  });
});
