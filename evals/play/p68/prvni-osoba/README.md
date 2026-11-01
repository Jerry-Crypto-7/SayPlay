# P68-F – Střelnice z očí (`railfps`)

Pruh P68-F: hra `railfps`, plán `plans/P68F-prvni-osoba-2026-10-31.md`. Předání pro P68-I je v `integration.md`.

## Zmrazené rozhraní (T1)

Kostra P68-I je v `origin/main` jako `15c81e6a` (PR #61); větev na ni přešla fast-forwardem.

- **Knihovna** (`src/play/arcade/library.ts`): ovládání `railfps` (`railfpsControl`), generátor `railfps_rail`
  (`railfpsRail`), robot `railfps_bot` (`railfpsBot`), pravidla `RAILFPS_RULES`. Exporty žijí v
  `pieces/railfps.ts` a `pieces/railfps-bot.ts`; jména se nemění.
- **Vstup** (`src/play/compose/stage-registry.ts`): `railfps: { scene: 'railfps', input: 'genre' }`, tedy vlastní
  dotykový adaptér `genres/railfps/RailfpsTouch.tsx` (props `{ session }`, registr `genres/touch-registry.ts`).
  Plánový `RailfpsRig.tsx` se nezakládá, jeho chování patří do `RailfpsTouch.tsx`.
- **Osa** (`src/play/genre/p68-contract.ts`): `RAILFPS_YAW_STEPS = 16`, krok `yawStep` −16..16, osa =
  trunc(krok × 1000 / 16). Sektor s = krok 4s = osa 250·s, střed se posílá osou 1. Natočení drží slot
  `RAILFPS_SLOTS.yawStep` (`BODY.x`) na držáku; těla mají jen `aux0` a `aux1`, takže stav míření je na držáku.
- **Verze překladu:** `GENRE_COMPILER_VERSION = 'genre.v7'` (`P68_GENRE_VERSION`).
- **`availability` kostry:** `stagedGenre(...)` dává `'staged'` a `compile` hází „Genre railfps is not live yet“.
  Hru nevidí klasifikátor (`ROUTE_PENDING`), režisér (`DIRECTOR_PENDING`) ani čtečka (`READER_PENDING`,
  `READ_CONTROLS`); zapne ji až úloha P68-I „zapoj railfps“.
- **Playwright:** `playwright test --list e2e/play-railfps.spec.ts` vidí `chromium`, `pixel7-touch` a `iphone-touch`
  (3 testy). Dočasný config není potřeba.
- **Publikace:** `POST /api/play/games` (`src/app/api/play/_publish.ts`) `availability` nečte. Spec `railfps` projde,
  jakmile modul umí `compile` (T4); se stubem kostry padne na „not live yet“.
- **Kombo:** `RAILFPS_RULES` nejsou v `HOOKED_GENRE_RULES` (`src/play/arcade/compile.ts`), takže zásahy počítají skóre
  bez násobiče. Potřeba jde do `integration.md`.
- **Test kostry, který T4 shodí:** `src/play/genre/__tests__/p68-staged.test.ts:68` čeká, že `compile` každé
  z pěti her hází „not live“, „dokud kategorie nedodá hru“. Hotový modul z T4 ho shodí. Soubor patří P68-I, takže
  ho tahle větev nemění; úprava (vyřadit `railfps` ze smyčky) je řádek v `integration.md`.

## Jádro (T2)

- `pieces/railfps-world.ts` (konstanty, osa ↔ sektor, celočíselné paprsky), `railfps-level.ts`
  (`checkRailfpsLevel(level, waves)`), `railfps.ts` (ovládání, pravidla `railfps_shot` a `railfps_round`, generátor
  `railfps_rail`). Test `pieces/__tests__/railfps.test.ts` 16/16.
- Konstanty: `turnTicks` 4 (celý oblouk −4 → +4 za 32 tiků, ~0,53 s), `fireInterval` 12, `reach` 4000, dostřel 30000,
  3 životy, `targets` 8–36 (výchozí 16), `waves` 2–5 (výchozí 3), nejvýš 12 věcí na vlnu, boss v poslední vlně (6 HP),
  časový limit 85 s.
- Odchylky od plánu: generátor se jmenuje `railfps_rail` (kostra), ne `railfps_waves`. Neprůchozí úroveň vrací
  `checkRailfpsLevel` jako `parts().issues` (stavba světa ji odmítne) místo výjimky, jako ostatní generátory. `win`
  padne v témž tiku jako poslední zásah (výstřel se vyhodnotí před kontrolou kol).
- **`mutationStatus: pass`** – všech 5 mutací zabito: střed kódovaný 0 (round trip, návrat do středu, boss, výhra na
  generované úrovni); výstřel bez čekání na doraz (západka, prázdný sektor, jiný sektor); zásah bez kontroly sektoru
  (tytéž + boss); `win` po první vlně (výhra až po poslední vlně, generovaná úroveň, meze generátoru); `Math.random`
  v generátoru (týž seed, grep zdroje).
