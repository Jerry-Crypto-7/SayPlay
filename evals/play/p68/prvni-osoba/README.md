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

## Robot, prohrávající hráči a záznam (T3)

- `railfps-bot.ts`: robot míří na nejbližší hrozbu (nejkratší čas do `reach`, při shodě nejmenší otočení); slabý
  hráč `railfpsWeakInputs(world)` je pevný záznam – FIRE každých 30 tiků do sektorů 0, 1, 0, −1.
  `railfps-trace.ts`: `traceRailfps(world, inputs, library, horizon?)` – knihovnu bere jako argument jako `replay`
  jádra, protože nic v `pieces/` neimportuje `library.ts`.
- Zásahy čte záznam z hlášení pravidla `railfps_shot` (despawn tímto pravidlem), ne z rozdílu živých těl: slot
  uvolněný zásahem může v témž tiku obsadit nový příchozí a nepřítel na `reach` v tiku výstřelu by jinak vypadal jako
  zásah.
- Výsledky (54 kombinací mezí a seedů): robot vyhraje za 10–39 s (výchozí meze 15–17 s) bez ztráty života, slabý
  i nečinný prohrají za 11–85 s. Dare: záznam robota ~280 B, nejhorší případ (robot + tah každý tik) 62,1 kB < 64 kB.
- Testy: `railfps-bot.test.ts` 10/10, `railfps-dare.test.ts` 3/3.
- **`mutationStatus: pass`** – robot o sektor vedle: zabito (výhra robota, ≥3 zásahy mimo střed, počet zásahů,
  Dare round trip). Aserce „sektor zasaženého těla = natočení“ sama nezčervená – jádro zásah vždy vede do sektoru,
  kam hráč hledí, takže mířící chyba se ukáže jen ve výsledku. `traceRailfps` počítá zásah bez výstřelu: zabito
  („výstřel v témž tiku“ na záznamu nečinného a slabého hráče).

## Modul žánru a věty (T4)

- `src/play/genre/railfps.ts`: `compile` přes `legacySpec`, nepřítel z `castFor`, terč, místo → `theme.look`,
  `objective.kind: 'defeat_targets'`, meze `targets` 8–36 a `waves` 2–5 podle jádra (stub kostry měl 3–60).
  `availability` zůstává `'staged'` jako v kostře, `cues` prázdné (návrh narážek je v `integration.md`).
- Fixture `e2e/fixtures/p68-railfps-spec.json` („Zap alien invaders in the space station hallway“) se přeloží,
  projde `checkRailfpsLevel` a robot ji vyhraje. Test `src/play/genre/__tests__/railfps.test.ts` 13/13.
- 20 vět (`sentences.json`; s13–s20 jsou dev věty P68-I d17–d24): **nepřítel 20/20, místo 19/20**.
  První běh s01–s12 našel dvě chyby modulu (u „shooting gallery at the county fair“ se nepřítelem stala galerie nebo
  pouť; nepřítel po „aim at“ se stal místem) – opravené v modulu, věty se nepřepisovaly.

| Věta | Nepřítel | Místo |
|---|---|---|
| s01 Zap alien invaders in the space station hallway | alien invader ✓ | space station hallway ✓ |
| s02 look around and shoot the zombies … abandoned mall | zombie ✓ | abandoned mall ✓ |
| s03 stand on the castle wall and fire arrows at the skeletons … | skeleton ✓ | castle wall ✓ |
| s04 blast the mutant rats swarming through the sewer tunnels | mutant rat ✓ | sewer tunnels ✓ |
| s05 through your own eyes on a pirate ship, shoot the sea monsters … | sea monster ✓ | pirate ship ✓ |
| s06 stand guard in a snowy forest and shoot the wolves … | wolf ✓ | snowy forest ✓ |
| s07 aim at the giant spiders crawling down the walls of the old temple | giant spider ✓ | – ✗ („of the old temple“ bez známé předložky) |
| s08 a shooting gallery at the county fair … wooden bears … | wooden bear ✓ | county fair ✓ |
| s09 riding a hover sled across the frozen lake, zap the ice gremlins … | ice gremlin ✓ | frozen lake ✓ |
| s10 inside a sunken submarine, shoot the killer sharks … | killer shark ✓ | sunken submarine ✓ |
| s11 turn left and right in the dusty canyon and blast the scorpions … | scorpion ✓ | dusty canyon ✓ |
| s12 ride a lava cart through the volcano and blast the fire imps … | fire imp ✓ | volcano ✓ |
| s13 a first-person ride in a mine cart on rails … bats … dark tunnels | bat ✓ | dark tunnels ✓ |
| s14 ride a train through the wild west and shoot the bandits … | bandit ✓ | wild west ✓ |
| s15 an on-rails shooter on a river boat … crocodiles … swamp | crocodile ✓ | swamp ✓ |
| s16 seen through the eyes of a kid on a roller coaster … clowns … | clown ✓ | roller coaster ✓ |
| s17 a ghost train ride through a haunted house … ghosts … | ghost ✓ | haunted house ✓ |
| s18 sit in a tour jeep … jungle road … angry monkeys … | angry monkey ✓ | jungle ✓ |
| s19 a first person rail shooter on a space station monorail, blasting drones … | drone ✓ | space station monorail ✓ |
| s20 ride a log flume through a pirate cove and soak the pirates … | pirate ✓ | pirate cove ✓ |

- **Sdílený test červený od T4:** `p68-staged.test.ts:68` („a skeleton does not compile … until its category ships“)
  čeká „not live“ od všech pěti her; hotový modul `railfps` se přeloží. Ostatní testy kostry (`p66-staged`,
  `director-prompt`, `p68-hash`) zelené. Úprava testu patří P68-I – řádek v `integration.md`.
