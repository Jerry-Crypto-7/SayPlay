import { describe, expect, it } from 'vitest';

import {
  IMAGE_PROPERTIES,
  IMAGE_THRESHOLDS,
  JUDGE_GRID,
  judgeImage,
  measureImage,
  pixelLuminance,
  type Pixels,
} from '../image-judge';

/**
 * Oracle úlohy T6 — **měřidlo měří to, co tvrdí**.
 *
 * Tohle je jediný soubor v plánu, na který se nikdo nedívá a přitom rozhoduje
 * o všem ostatním: soudce certifikuje dvacet světů v T7 a garantuje podlahu
 * v T11. Chybné měřidlo tedy tiše prohlásí ošklivý výstup za hezký a nikdo se
 * to nedozví — proto se soudí nad **syntetickými** obrazy, kde je pravda známá
 * předem, ne nad vyrenderovanou scénou, kde ji nikdo nezná.
 *
 * Každá z pěti vlastností má obraz, který propadne **právě na ní**. Kdyby
 * propadal na několika, nešlo by rozhodnout, která aserce ho chytila.
 */

const WIDTH = 160;
const HEIGHT = 90;

/** Prázdné plátno RGBA. Alfa je plná — soudce ji nečte, ale snímek z prohlížeče ji nese. */
function canvas(width = WIDTH, height = HEIGHT): { data: Uint8ClampedArray } & Pixels {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

function paint(
  image: { data: Uint8ClampedArray } & Pixels,
  color: (x: number, y: number) => readonly [number, number, number],
): { data: Uint8ClampedArray } & Pixels {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      const [r, g, b] = color(x, y);
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = 255;
    }
  }
  return image;
}

/** Jednolitá šedá plocha. Propadá na rozptylu jasu i na mrtvé ploše. */
function flatGrey() {
  return paint(canvas(), () => [128, 128, 128]);
}

/**
 * Pozadí všech dobrých snímků: studený spád shora dolů.
 *
 * Spád je **naměřený, ne zvolený**. Přes 90 řádků jde jas z 25 na 140, takže
 * na jednu buňku mřížky (10 řádků) připadá rozpětí ~12,8 — nad prahem mrtvé
 * plochy 8, ale hluboko pod čímkoli, co by kradlo ohnisko. Plošší spád by
 * pozadí prohlásil za mrtvé a všechny čtyři snímky níž by padaly na `dead`
 * místo na vlastnosti, kterou zkoušejí.
 */
function coolGradient(x: number, y: number): readonly [number, number, number] {
  const down = y / HEIGHT;
  return [18 + down * 70, 32 + down * 105, 70 + down * 60];
}

/**
 * Obraz, který obstojí ve všech pěti: spád pozadí, jedno jasné ohnisko
 * s ostrým vzorem uvnitř a třetí odstín u dolní hrany.
 */
function goodImage() {
  const image = paint(canvas(), coolGradient);

  // Ohnisko: teplý objekt s pruhy. Rozpětí jasu uvnitř ~126, tedy desetkrát
  // víc než kterákoli buňka pozadí — ohnisko je tím jednoznačné.
  for (let y = 20; y < 60; y += 1) {
    for (let x = 40; x < 80; x += 1) {
      const at = (y * WIDTH + x) * 4;
      const stripe = (x + y) % 6 < 3;
      image.data[at] = stripe ? 250 : 120;
      image.data[at + 1] = stripe ? 210 : 80;
      image.data[at + 2] = stripe ? 110 : 30;
    }
  }

  // Třetí odstín: zelený pás u dolní hrany. Jasem sedí na pozadí, takže
  // nepřebíjí ohnisko — nese jen barvu.
  for (let y = 78; y < 88; y += 1) {
    for (let x = 4; x < 150; x += 1) {
      const at = (y * WIDTH + x) * 4;
      image.data[at] = 70;
      image.data[at + 1] = 160;
      image.data[at + 2] = 60;
    }
  }

  return image;
}

/** Dvě stejně silná ohniska daleko od sebe. Propadá na jednoznačnosti. */
function twoRivals() {
  const image = goodImage();
  // Kopie ohniska na opačnou stranu obrazu, bod po bodu — dvě buňky s týmž
  // rozpětím jasu, tedy dvě stejně silná ohniska a žádné hlavní.
  for (let y = 20; y < 60; y += 1) {
    for (let x = 40; x < 80; x += 1) {
      const from = (y * WIDTH + x) * 4;
      const to = (y * WIDTH + (x + 76)) * 4;
      image.data[to] = image.data[from];
      image.data[to + 1] = image.data[from + 1];
      image.data[to + 2] = image.data[from + 2];
    }
  }
  return image;
}

/** Jeden odstín přes celý obraz, jinak v pořádku. Propadá na počtu odstínů. */
function singleHue() {
  const image = paint(canvas(), (_x, y) => {
    // Týž odstín (oranžová) v celém obraze, mění se jen světlost.
    const level = 22 + (y / HEIGHT) * 120;
    return [level * 1.6, level, level * 0.35];
  });

  for (let y = 20; y < 60; y += 1) {
    for (let x = 40; x < 80; x += 1) {
      const at = (y * WIDTH + x) * 4;
      const level = (x + y) % 6 < 3 ? 175 : 55;
      image.data[at] = level * 1.6;
      image.data[at + 1] = level;
      image.data[at + 2] = level * 0.35;
    }
  }

  return image;
}

/**
 * Ohnisko bez jediné hrany: měkká koule místo objektu. Propadá na siluetě.
 *
 * Konstrukce je záměrná. Zploštit objekt na jednu barvu nestačí — tím by
 * z obrazu zmizelo i ohnisko, soudce by ho našel jinde a měřil by siluetu
 * něčeho úplně jiného. Spojitý přechod má naopak velké **rozpětí** přes buňku
 * (ohnisko zůstane tady), ale rozdíl dvou sousedních pixelů pod prahem hrany.
 */
function blurredFocus() {
  const image = paint(canvas(), coolGradient);
  const radius = 34;

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const distance = Math.hypot(x - 60, y - 40);
      if (distance > radius) continue;
      const at = (y * WIDTH + x) * 4;
      // 160 úrovní jasu rozložených na 34 pixelů = 4,7 na krok, tedy třetina
      // prahu hrany. Buňka přes deset pixelů má rozpětí ~47, tedy ohnisko.
      const rise = 1 - distance / radius;
      image.data[at] = 60 + rise * 180;
      image.data[at + 1] = 50 + rise * 150;
      image.data[at + 2] = 30 + rise * 70;
    }
  }

  return image;
}

describe('soudce nad syntetickými snímky', () => {
  it('obraz s tmami, středy, světly, ohniskem a třemi odstíny obstojí ve všech pěti', () => {
    const verdict = judgeImage(goodImage());

    expect(verdict.failed).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('jednolitá šedá plocha propadne na rozptylu jasu i na mrtvé ploše', () => {
    // AC úlohy. Šeď je nejtvrdší případ: nemá jediné pásmo navíc, jedinou
    // hranu ani jediný odstín, takže se na ní pozná i měřidlo, které nic neměří.
    const verdict = judgeImage(flatGrey());

    expect(verdict.measured.luminanceSpread).toBe(1 / 5);
    expect(verdict.measured.dead).toBe(1);
    expect(verdict.failed).toContain('luminanceSpread');
    expect(verdict.failed).toContain('dead');
  });

  it('dvě stejně jasné skvrny propadnou na jednoznačnosti ohniska', () => {
    const verdict = judgeImage(twoRivals());

    expect(verdict.measured.focusClarity).toBeLessThan(IMAGE_THRESHOLDS.minFocusClarity);
    expect(verdict.failed).toContain('focusClarity');
  });

  it('obraz s jedním odstínem propadne na počtu odstínů', () => {
    const verdict = judgeImage(singleHue());

    expect(verdict.measured.hues).toBeLessThan(IMAGE_THRESHOLDS.minHues);
    expect(verdict.failed).toContain('hues');
  });

  it('ohnisko bez vnitřní kresby propadne na čitelnosti siluety', () => {
    const verdict = judgeImage(blurredFocus());

    expect(verdict.measured.silhouette).toBeLessThan(IMAGE_THRESHOLDS.minSilhouette);
    expect(verdict.failed).toContain('silhouette');
  });

  it('ohnisko se najde tam, kde objekt opravdu je', () => {
    // Objekt leží v pásu x 40–80 z 160 a y 20–60 z 90, tedy zhruba ve třetině
    // šířky a v polovině výšky. Bez téhle aserce by „poloha ohniska" mohla
    // vracet střed obrazu a nikdo by to nepoznal.
    const [x, y] = measureImage(goodImage()).focusAt;

    expect(x).toBeGreaterThan(0.2);
    expect(x).toBeLessThan(0.55);
    expect(y).toBeGreaterThan(0.15);
    expect(y).toBeLessThan(0.75);
  });

  it('plochý obraz nemá ohnisko, ne dokonalé ohnisko', () => {
    // Dělení nulou by ze šedi udělalo nejjednoznačnější obraz, jaký soudce zná.
    expect(measureImage(flatGrey()).focusClarity).toBe(0);
  });

  it('monochrom má nula odstínů, ne dvanáct', () => {
    expect(measureImage(flatGrey()).hues).toBe(0);
  });
});

describe('vada vstupu je vada, ne nula', () => {
  it('prázdné pole', () => {
    expect(() => measureImage({ data: new Uint8ClampedArray(0), width: 4, height: 4 })).toThrow(
      /prázdný|žádá/,
    );
  });

  it('pole s jiným počtem kanálů', () => {
    // Tři kanály místo čtyř: pole vypadá jako obraz a měřilo by se posunuté.
    expect(() =>
      measureImage({ data: new Uint8ClampedArray(4 * 4 * 3).fill(120), width: 4, height: 4 }),
    ).toThrow(/RGBA/);
  });

  it('nulová plocha', () => {
    expect(() => measureImage({ data: new Uint8ClampedArray(0), width: 0, height: 8 })).toThrow(
      /nulovou plochu/,
    );
    expect(() => measureImage({ data: new Uint8ClampedArray(0), width: 8, height: 0 })).toThrow(
      /nulovou plochu/,
    );
  });

  it('zlomkové rozměry', () => {
    expect(() =>
      measureImage({ data: new Uint8ClampedArray(64).fill(1), width: 4.5, height: 4 }),
    ).toThrow(/celá čísla/);
  });

  it('snímek menší než mřížka se pořád změří', () => {
    // 8×4 je méně buněk, než má mřížka sloupců. Buňka musí zůstat aspoň
    // jednopixelová, jinak by se dělilo nulou a soudce by spadl na obrazu,
    // který je jen malý — ne vadný.
    const tiny = paint(canvas(8, 4), (x) => [x * 30, 20, 200 - x * 20]);

    expect(() => measureImage(tiny)).not.toThrow();
    expect(measureImage(tiny).dead).toBeLessThanOrEqual(1);
  });
});

describe('prahy a slovník drží pohromadě', () => {
  it('pět vlastností je pět a každá má práh', () => {
    expect(IMAGE_PROPERTIES.length).toBe(5);
    expect(Object.keys(IMAGE_THRESHOLDS)).toEqual(
      expect.arrayContaining([
        'minLuminanceSpread',
        'minFocusClarity',
        'minSilhouette',
        'minHues',
        'maxDead',
      ]),
    );
  });

  it('mřížka má poměr stran snímku, ne čtverec', () => {
    // Na obdélníkové buňce by mrtvá plocha znamenala nahoře něco jiného než
    // po stranách, protože by se počítala z různě velkých kusů obrazu.
    expect(JUDGE_GRID.columns / JUDGE_GRID.rows).toBeCloseTo(16 / 9, 2);
  });

  it('jas je BT.709, tedy tentýž jako všude jinde v repu', () => {
    // Dvě definice jasu by daly dvě různé pravdy o tomtéž snímku. Měří se
    // odezvou na čistě zelený a čistě modrý obraz: zelená váží 0,7152 a modrá
    // 0,0722, takže zelený obraz musí padnout o tři pásma výš než modrý.
    // Prostý průměr kanálů by dal zelené i modré 85 a rozdíl by zmizel.
    expect(pixelLuminance(255, 0, 0)).toBeCloseTo(0.2126 * 255, 6);
    expect(pixelLuminance(0, 255, 0)).toBeCloseTo(0.7152 * 255, 6);
    expect(pixelLuminance(0, 0, 255)).toBeCloseTo(0.0722 * 255, 6);
    expect(pixelLuminance(255, 255, 255)).toBeCloseTo(255, 4);
    expect(pixelLuminance(0, 0, 0)).toBe(0);

    // A že těch vah soudce doopravdy používá: čistě zelený obraz je jasný,
    // čistě modrý tmavý, a soudce je proto pošle do různých pásem.
    const green = judgeImage(paint(canvas(), () => [0, 255, 0]));
    const blue = judgeImage(paint(canvas(), () => [0, 0, 255]));

    expect(green.measured.hues).toBe(1);
    expect(blue.measured.hues).toBe(1);
    expect(green.failed).toContain('luminanceSpread');
    expect(blue.failed).toContain('luminanceSpread');
  });
});
