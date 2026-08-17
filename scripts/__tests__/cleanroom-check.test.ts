/**
 * Dvě protichůdná tvrzení o tom, kdo nastavuje prominutí clean-room brány.
 *
 * `.githooks/pre-commit` si `CLEANROOM_ALLOW_UNPROVISIONED=1` nastavuje sám, na
 * jeden běh. Hlavička `cleanroom-check.mjs` to říkala správně, komentář o tři sta
 * řádků níž a `ops/cleanroom-provisioning.md` tvrdily opak — tedy že se commit
 * v nenaplněném stavu bez vědomého obejití neprovede. Kdo by podle toho
 * dokumentu provisionoval druhý stroj, čekal by bránu, která tam není.
 *
 * **Je to lexikální kontrola textu, ne kontrola chování** — přesně jako brána,
 * které se týká. Co hook s prominutím doopravdy dělá a kam až sahá (jedna brána,
 * ne obě), drží `pre-commit-hook.test.ts`; tady jde jen o to, aby si zdrojáky
 * a dokument neprotiřečily.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = readFileSync(join(process.cwd(), 'scripts', 'cleanroom-check.mjs'), 'utf8');
const DOC = readFileSync(join(process.cwd(), 'ops', 'cleanroom-provisioning.md'), 'utf8');
const HOOK = readFileSync(join(process.cwd(), '.githooks', 'pre-commit'), 'utf8');

/** Tvrzení „hook prominutí nenastavuje", ve všech tvarech, které tu kdy stály. */
const DENIES_HOOK_SETS_IT = /hook\s+(?:si\s+)?(?:ji|je|tu\s+proměnnou|proměnnou)?\s*nenastavuje/i;

describe('dokument a komentáře popisují ten waiver, který hook opravdu nastavuje', () => {
  it('hook prominutí skutečně nastavuje — to je ta pravda, proti které se měří', () => {
    // Kdyby tuhle řádku někdo z hooku vyndal, obrátí se pravdivostní hodnota
    // všech tvrzení níž a tenhle test by je hlídal proti neexistujícímu chování.
    expect(HOOK).toMatch(/CLEANROOM_ALLOW_UNPROVISIONED=1 node scripts\/cleanroom-check\.mjs/);
  });

  it('cleanroom-check.mjs netvrdí, že hook prominutí nenastavuje', () => {
    expect(SCRIPT).not.toMatch(DENIES_HOOK_SETS_IT);
  });

  it('cleanroom-check.mjs naopak jmenuje hook jako toho, kdo ho nastavuje', () => {
    // Bez téhle poloviny by prošel i soubor, který o prominutí mlčí úplně —
    // a mlčení je ta samá vada, jen se hůř najde.
    expect(SCRIPT).toMatch(/Kdo ji nastavuje: `\.githooks\/pre-commit`/);
  });

  it('cleanroom-check.mjs jmenuje dosah prominutí: jedna brána, ne obě', () => {
    expect(SCRIPT).toMatch(/jedna z nich, ne obě/);
  });

  it('ops/cleanroom-provisioning.md netvrdí, že hook prominutí nenastavuje', () => {
    expect(DOC).not.toMatch(DENIES_HOOK_SETS_IT);
  });

  it('ops/cleanroom-provisioning.md říká, co se v nenaplněném stavu opravdu stane', () => {
    // Dokument je jediné místo, odkud by druhý inženýr provisionoval. Musí z něj
    // jít vyčíst, že commit projde a že samostatný běh i CI selžou.
    expect(DOC).toMatch(/npm run gate:cleanroom/);
    expect(DOC).toMatch(/commit projde/);
  });
});
