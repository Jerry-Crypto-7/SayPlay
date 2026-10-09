# P45F – druhý pokus o jména, která v P45E neprošla

Plán: P45F (interní). Větev převzala fast-forwardem `features/P45E-generovani-modelu-2026-10-08` (`52fb322b`, PR #31) – slučuje se **po P45E**.

## Odkud jsou jména

- `evals/play/p45e/gen-round.md` – 60 jmen, která v P45E neprošla předkontrolou obrázku, branou kvality nebo slepým soudem, a co v obrázku místo nich viděl Codex (oddíly „Soudce poznal něco jiného“ a „Předkontrola odmítla všechny tři obrázky“ v T4 i dávkách T5).
- Zjištění P45E: ruční rozlišovací znak v `ops/gen3d/features.toml` mělo ze zbytku T5 jen 1 z 39 jmen; úspěšnost soudu T5 18 % proti 42 % u T4. P45F proto každému neprošlému jménu píše znak podle toho, co soudce viděl místo něj, a nic jiného na generátoru nemění.
- Mimo: lizard, demon, wolf (soud prošel, povýšení narazí na testy v `src/play`), dynamite (LOD1), nová jména, kód generátoru.

## Seznam a znaky (T2)

- `retry-nouns.json` – **58** z 60 neprošlých jmen P45E, podle počtu vět v `evals/play/p45d/missing.json`, pak abecedně (19 jmen má 1–2 věty, zbytek 0). Každé nese třídu ze vstupu P45E a co soudce viděl místo něj. Třídu jsme opravili u tří jmen, kde šablona zadání kreslila něco jiného: broomstick flyer → prop (šablona „wings spread wide“ dala čarodějnici), peacock flyer → prop (roztažený vějíř ocasu třikrát neprošel bránou kvality), moon rover prop → vehicle.
- `ops/gen3d/features.toml` – ruční znak pro všech 58 (oddíl „P45F“), komentář `# P45E:` nese, co soudce viděl. Znaky jen přepsané nebo nové, kód generátoru beze změny.
- **cyclops nikdy znak nedostal:** dávka jméno normalizuje na „cyclop“ (`ops/gen3d/cache.py`, množné číslo), `batch.prompt_for` hledá znak pod normalizovaným klíčem, takže `cyclops = …` z P45E se do zadání nepřipsal. Klíč je teď `cyclop`, stejně `canva` pro canvas.
- **Vyřazeno (2):**
  - mane – část zvířete, ne samostatná věc: sama hříva vyjde jako věnec nebo šiška (P45E), se zvířetem by soudce viděl lva.
  - fuel – látka; nádobu kreslí od P45E `gen3d-fuel-can`, patří mezi synonyma, ne nový model.

## Okno a strop

- Karta RTX 3090 sdílená s P45B, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`.
- Po **9. 10. 2026 09:15** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`.
- Codex na předplatné: strop celého P45F **150 volání** (předkontrola + slepý soud). Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí.

## Souhrn kola (9. 10. 2026, 07:43–09:22)

| | Jmen | Předkontrola a brána | Slepý soud | Povýšeno |
|---|---|---|---|---|
| P45F, 5 dávek po 10 | 50 | 37 | **18 (36 %)** | **15 (30 %)** |
| stejných 50 jmen v P45E | 50 | 21 | 0 (0 %) | 0 |

- **Úspěšnost:** soud 36 % proti celému P45E 31 % a proti stejným jménům v P45E 0 %. Jediná změna oproti P45E je ruční znak (a třída u tří jmen), generátor i soudce stejné. Po dávkách a jménech `gen-round.md`.
- **Povýšeno do knihovny (15):** coffin, bank manager, chimney, firefly, stone golem, net, stickman, cape, coral, flower pot, glue, joystick, earring, firework, milk. Každý s licencí a původem v `disclosure.json`. Cíl plánu ≥ 10 splněn.
- **Přijaté soudem, nepovýšené (3):** anthill, captain, chicken leg. `scripts/assets/p32-manifest.mjs` jim dá záznam v `src/play/assets/entries/catalog.json` (anthill → animal podle „ant“, chicken leg → bird podle „chicken“, captain → humanoid) a pin počtu v `src/play/assets/__tests__/catalog-entries.test.ts` zčervená; P45F do `src/play` nesmí → `--drop`. Modely v `D:/claude/_gen3d-cache-p45f/`; anthill a chicken leg potřebují spíš opravu třídy v manifestu než zvednutí pinu.
- **Co zbylo (40):**
  - 8 nezpracovaných kvůli oknu – rhino, singer, space station, swing, tablet, tape, tea, torpedo. Znak mají, dávka 6 je připravená v `D:/caches/p45f/round6/list.json`.
  - 32 zkoušených a neprošlých – soudce viděl něco jiného (19), předkontrola odmítla všechny tři obrázky (11; dumpling a marshmallow se správným jménem, ale obrázek „rozbitý“), brána kvality (2: golem; golf ball, který předkontrola poznala).
- **Neprošlé kvůli porovnání jména, ne kvůli obrázku (zjištění pro kód generátoru, mimo P45F):** cyclops – předkontrola třikrát řekla „cyclops“, dávka ale jméno zkrátí na „cyclop“ (`ops/gen3d/cache.py`, `IRREGULAR`); pinecone – třikrát „pine cone“, předkontrola bere jen přesné slovo. Synonyma by pustila i broomstick („broom“) a role lidí (financial advisor → businesswoman, poacher → thief).
- **Codex:** 125 ze 150 volání (88 předkontrol + 37 soudů), limit nedošel.

## Sady (T4, 9. 10. 2026 09:23–11:17)

Po každé dávce prošly `src/assets`, `scripts/p37d`, `models-qa`, `hero-choice` a `catalog-entries` (poslední 1110/1110). `evals/play/catalog-coverage.json` po nových modelech zastaral (952 → 967 modelů) – přegenerováno `node scripts/assets/cc0/coverage.mjs`, test pokrytí prošel.

`npx vitest run src/assets scripts src/play/arcade/__tests__` běžel s CPU na 100 % od cizí zátěže (ffmpeg/Blender a vitest jiného projektu), proto **nejde o běh v klidu**: 139 souborů, 10 červených (19 testů), všechny na časový limit, žádné tvrzení o datech. Opakování po souborech, zátěž trvala:

- **prošly napodruhé:** `promote.test.ts` (fialová barva, původ a licence, velikost modelů) a `external-import.test.ts` 27/27 s delším limitem; `license-gate`, `quest`, `arena-modes`, `blind-check` (56/56).
- **zapsané, nejsou vada P45F:** `submission-check.test.ts` čte gitignorovaný `plans/P8-odevzdani.md`, který worktree nemá; `submission-check-gate.test.ts` 59/59 testů prošlo, jen úklid dočasných repozitářů přetekl 10 s.
- **pořád červené pod zátěží – ověřit během celé sady v klidu před pushem:** `src/assets/__tests__/loader.test.ts` „accepts every packaged model and LOD“ (pevný limit 180 s na průchod všemi 967 modely po dvou LOD; komentář v testu počítá s ~450) a `scripts/__tests__/p32-heavy.test.ts` (zámek hlásí čekání jednou místo dvakrát). P45F mění jen data, ne kód těchto testů; obsahovou kontrolu nových modelů drží `models-qa` a `promote.test.ts`, které prošly.

## Slučování

Slučuje se **po P45E** (větev P45F na ní stojí). Konflikt v `src/assets/catalog-motion.json` se neřeší ručně: vzít libovolnou stranu a znovu spustit `node scripts/p45d/motion-class.mjs` (soubor nese hash katalogu, test čerstvosti `src/assets/__tests__/catalog-motion.test.ts`). Stejně `evals/play/catalog-coverage.json` – po sloučení `node scripts/assets/cc0/coverage.mjs`. `src/play` a `src/components` P45F nemění.
