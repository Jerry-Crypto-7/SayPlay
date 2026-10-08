# P45E – generování chybějících 3D modelů

Vyčleněno z P45D (úlohy T17–T19), aby karta RTX 3090 nečekala na animace. Plán: P45E (interní), spec `docs/specs/2026-10-08-p45-hloubka-a-zabava.md` (interní).

## Odkud jsou jména

Větev převzala fast-forwardem commit P45D `133167ba` (T1 základ, T2 třída těla, T3 soudce pohybu, T16 výběr jmen) – stejné commity jako na `features/P45D-zive-postavy-2026-10-08`, při slučování nekonfliktí.

- `evals/play/p45d/missing.json` – 118 jmen, která lidé píšou a knihovna nekreslí (`scripts/p37d/missing-nouns.mjs`, 8. 10. 2026).
- `evals/play/p45d/gen-nouns.json` – 48 z nich vybraných pro generátor (`scripts/p45d/pick-nouns.mjs`): 2 hrdinové panelu P43 (cyclops, mole), 29 podle počtu vět, 17 záměn soudce P43; 13 plochých nebo drobných.
- Třída těla pro šablonu zadání: `scripts/p45d/motion-class.mjs` (`quadruped`, `biped`, `flyer`, `swimmer`, `vehicle`, `prop`; `flat` = ploché nebo drobné).

P45E tyhle soubory jen čte; `src/assets/catalog-motion.json` se po povýšení regeneruje `node scripts/p45d/motion-class.mjs`.

## Okno stroje

Stroj volný 8. 10. 2026 večer do **9. 10. 2026 08:00**. Po **9. 10. 2026 07:30** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší a zbytek se zapíše do `gen-round.md`. Karta je sdílená s P45B (lokální gpt-oss-20b) – každý běh na ní jde přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`.

## Souhrn kola (8. 10. 2026, 21:04–23:51)

| Část | Jmen | Předkontrola a brána | Slepý soud | Povýšeno |
|---|---|---|---|---|
| T4 – 48 vybraných (`gen-nouns.json`) | 48 | 33 | 20 (42 %) | 18 |
| T5 – zbytek podle poptávky | 39 | 20 | 7 (18 %) | 5 |
| **Celkem** | **87** | **53** | **27 (31 %)** | **23 (26 %)** |

- **Úspěšnost proti P43 (25 %):** cíl ≥ 40 % splnilo kolo nad vybranými jmény (T4 42 %); zbytek bez vět a bez ručního znaku v `ops/gen3d/features.toml` táhne celek na 31 %. Pilot T3 na 15 jménech, která v P43 neprošla: 10/15 (P43 0/15).
- **Povýšeno do knihovny (23):** hippo, spy, spaghetti, ramp, orca, searchlight, snowmobile, genie, orange, pie, statue, snowboard, playing card, crossbow, dishwasher, jetpack, paper ball, portrait (T4); fuel can, juice, printer, noodle, orb (T5). Každý s licencí a původem v `disclosure.json`.
- **Přijaté soudem, nepovýšené (4):** lizard, demon, wolf – model by změnil výsledek testů v `src/play` (`hero-choice.test.ts`, pin počtu 261 v `catalog-entries.test.ts`), kam P45E nesmí; dynamite – nejde z něj vyrobit LOD1. Modely jsou v mezipaměti `D:/claude/_gen3d-cache-p45e/`, povýšení po úpravě testů popisuje `gen-round.md`.
- **Co zbylo:** 60 jmen neprošlo předkontrolou, branou nebo soudem – po jménech a s tím, co v obrázku viděl Codex, v `gen-round.md`. Nezpracované jméno nezbylo; okno ani limit Codexu (~266 ze 400 volání) nedošly.
- **Další kolo:** ruční rozlišovací znak pro odmítnutá jména (T5 ho měla 1 z 39) a synonyma rolí lidí do předkontroly (bank manager → businessman), ne další semínko.

## Slučování

P45E se slučuje **po P45D** (pořadí A → B → C → D → E). Konflikt v `src/assets/catalog-motion.json` se neřeší ručně: vzít libovolnou stranu a znovu spustit `node scripts/p45d/motion-class.mjs` (soubor nese hash katalogu a test čerstvosti `src/assets/__tests__/catalog-motion.test.ts` ho hlídá). `src/play` a `src/components` P45E nemění.

**Před sloučením opravit jeden test mimo hranice P45E:** `scripts/p45d/__tests__/pick-nouns.test.ts:62` („picks from the real repo nothing the catalog already covers“) čte zmrazený `evals/play/p45d/missing.json`, ale pokrytí počítá z dnešního katalogu – po povýšení P45E 19 vybraných jmen (paper ball …) knihovna kreslí, a test proto zčervená. Na větvi P45D je zelený; patří do linie P45D (`scripts/p45d` P45E nesmí): pokrytí brát z katalogu v commitu výběru, nebo po sloučení přegenerovat `missing.json`.

Celá sada v noci 8./9. 10. 2026 (sama, 552 souborů, 12 156 testů): 16 červených, po opakování jen těch 15 souborů zbyly 4 – `upgrade.test.ts` časový (napodruhé prošel), `evals/play/catalog-coverage.json` zastaralý po nových modelech (přegenerováno `node scripts/assets/cc0/coverage.mjs`, models 929 → 952, test prošel), `pick-nouns.test.ts` výše a `scripts/__tests__/submission-check.test.ts`, který čte gitignorovaný `plans/P8-odevzdani.md` – worktree ho nemá, hlavní checkout ano.
