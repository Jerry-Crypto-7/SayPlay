/**
 * Brána K1 — řekne ten jazyk dvanáct různých věcí? (P13 vlna 1 T7)
 *
 * **Report se zapisuje dřív, než se cokoli tvrdí.** Kdyby se zapisoval až
 * nakonec, první propadlá dvojice by běh zabila a `diversity.json`, ve kterém je
 * vidět *která* dvojice a o kolik, by nevznikl — tedy přesně tehdy, kdy je
 * nejvíc potřeba. Stejný důvod jako v `evals/__tests__/hostile-report.test.ts`.
 *
 * ## Co tenhle soubor tvrdí
 *
 * 1. Všech dvanáct programů projde bránou jazyka a **žádný se nevymeshuje
 *    naprázdno**. Prázdný mesh je tichá vada: siluety by byly samé nuly, dva
 *    prázdné tvary by měly vzdálenost 0 a duplicitní otisk — vypadalo by to
 *    jako shoda tvarů, i když je to shoda ničeho.
 *
 *    **Brána jazyka je jediná věc, která nemá vlastní `it`, a je to schválně.**
 *    Musí proběhnout dřív než meshing, jinak neplatný program spadne uvnitř
 *    vyhodnocovače a shodí `beforeAll` — a s ním i ten `it`, který ho měl
 *    pojmenovat. Zkoušeno mutací 29. 8. 2026: pojmenovaný test se v tom případě
 *    **přeskočí**, takže by byl ozdobný. Stráž v `beforeAll` selže hlasitěji,
 *    protože vypíše, který tvar a proč.
 * 2. Žádné dva tvary nemají **shodný otisk geometrie** (detektor duplikátu).
 * 3. Všech 66 dvojic je **nad prahem** `DIVERSITY_THRESHOLD`.
 * 4. **Semínko nevyrobí jiný tvar** — tentýž program pod posunutým semínkem musí
 *    zůstat hluboko pod prahem. Bez tohohle by se práh dal projít šumem.
 *
 * ## Co netvrdí
 *
 * Že dvanáct tvarů vypadá **modelovaně**. To je brána H1 a rozhoduje ji člověk
 * nad `/gallery`; stroj umí odpovědět jen na „jsou různé", ne na „jsou hezké".
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { GALLERY, GALLERY_IDS, GALLERY_SEED } from '../gallery';
import {
  DIVERSITY_THRESHOLD,
  buildDiversityReport,
  profileShape,
  shapeDistance,
  type DiversityReport,
} from '../measure-diversity';
import { validateShapeProgram } from '../../../src/shape/schema';
import { meshShapeProgram } from '../../../src/shape/surface-nets';
import { DIVERSITY_RESOLUTION } from '../measure-diversity';

const ARTIFACT = join(process.cwd(), 'evals/shape/diversity.json');

/**
 * O kolik se posune semínko v důkazu „semínko není tvar". 977 je prvočíslo,
 * takže nepadne na násobek žádné frekvence `displace` v galerii.
 */
const SEED_SHIFT = 977;

/**
 * Naměřená rezerva mezi největším šumem ze semínka a prahem. Drží aserci
 * „práh není přestřelený" poctivou: kdyby šum ze semínka lezl k prahu, měřidlo
 * by pod 0,15 nerozlišovalo tvar od téhož tvaru jinak zašuměného.
 */
const SEED_NOISE_CEILING = DIVERSITY_THRESHOLD / 4;

describe('evals/shape — dvanáct tvarů je dvanáct různých tvarů', () => {
  let report: DiversityReport;

  beforeAll(() => {
    // **Brána jazyka běží před meshingem.** Program, který odkáže na uzel mimo
    // tabulku, spadne až hluboko ve vyhodnocovači na
    // `Cannot read properties of undefined (reading 'kind')`; `beforeAll` tím
    // shodí celý soubor, všech sedm testů se **přeskočí** a aserce, která tu
    // vadu umí pojmenovat, se nikdy nespustí. Naměřeno mutací 29. 8. 2026.
    const rejected = GALLERY.filter((item) => !validateShapeProgram(item.program).ok).map(
      (item) => item.id,
    );
    if (rejected.length > 0) {
      throw new Error(`gallery has programs the language rejects: ${rejected.join(', ')}`);
    }

    // **Artefakt se napřed smaže.** Commitnutý `diversity.json` na disku leží,
    // takže aserce „vyrobí report na dohodnuté cestě" bez tohohle přečte starý
    // soubor a projde i tehdy, když běh nezapsal vůbec nic. Naměřeno mutací
    // 29. 8. 2026: vypnutý zápis nechal celou sadu zelenou.
    rmSync(ARTIFACT, { force: true });

    report = buildDiversityReport(GALLERY, GALLERY_SEED, new Date().toISOString().slice(0, 10));
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('vyrobí report na dohodnuté cestě', () => {
    const written = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as DiversityReport;

    expect(written.pairs).toHaveLength(report.pairs.length);
    expect(written.threshold).toBe(DIVERSITY_THRESHOLD);
    expect(written.resolution).toBe(DIVERSITY_RESOLUTION);
  });

  it('má právě dvanáct předepsaných jmen', () => {
    expect(GALLERY.map((item) => item.id)).toEqual([...GALLERY_IDS]);
  });

  it('žádný tvar se nevymeshuje naprázdno', () => {
    // Prázdný mesh je tichá vada — viz hlavička. Měří se přímo, ne přes profil,
    // protože profil prázdného meshe vypadá jako platný profil samých nul.
    const empty = GALLERY.filter(
      (item) =>
        meshShapeProgram(item.program, GALLERY_SEED, {
          resolution: DIVERSITY_RESOLUTION,
          bounds: item.program.targetBounds,
        }).triangleCount === 0,
    ).map((item) => item.id);

    expect(empty).toEqual([]);
  });

  it('žádné dva tvary nemají shodný otisk geometrie', () => {
    expect(report.duplicateHashes).toEqual([]);
  });

  it('všech 66 dvojic je nad prahem', () => {
    const pairs = (GALLERY.length * (GALLERY.length - 1)) / 2;
    expect(report.pairs).toHaveLength(pairs);

    const tooClose = report.pairs
      .filter((pair) => pair.distance < DIVERSITY_THRESHOLD)
      .map((pair) => `${pair.a}/${pair.b} = ${pair.distance}`);

    expect(tooClose).toEqual([]);
  });

  it('jiné semínko nevyrobí jiný tvar', () => {
    // Druhá strana téhož prahu. Aserce nahoře říká „různé tvary jsou daleko";
    // tahle říká „týž tvar zůstane blízko", jinak by práh šlo projít šumem.
    const drift = GALLERY.map((item) => ({
      id: item.id,
      distance: shapeDistance(
        profileShape(item.program, GALLERY_SEED),
        profileShape(item.program, GALLERY_SEED + SEED_SHIFT),
      ),
    }));

    const noisy = drift
      .filter((item) => item.distance > SEED_NOISE_CEILING)
      .map((item) => `${item.id} = ${item.distance.toFixed(4)}`);

    expect(noisy).toEqual([]);
  });
});
