# P66 – nové žánry a háčky

Plán: `plans/P66-nove-zanry-a-hacky-2026-10-28.md` (gitignorovaný). Každá úloha má svou sekci.

## T1 – štítky žánrů, dosah, otisk, zapečetěná sada, výchozí stav `main`

Všechno v T1 běží nad čistým `main` `e661855c` ve worktree `D:/caches/p66/main` (build `npm run build`), ne nad větví.

### Zapečetěná sada

`holdout.json` – 30 nových anglických vět napsaných 28. 10. 2026 před první změnou kódu P66: 15 míří na nové žánry (3 na každý: survivor, díra, krádež, třídění, šipky; `half: "new"`, `genre` = žánr, na který věta míří) a 15 obecných (`half: "general"`, `genre` = `classifyGenre` na `main` při zapečetění) přes 15 různých dnešních žánrů – hlídají, že nové žánry nekradou věty.

SHA-256 nad LF bajty: `42bf10ccca56ea5dab0b0c06cca9401701b3bb3980794c31da9a853c99c9e611` (`seal.ts`). Otevře se jednou v T16 (`openSealedOnce`); nic se podle ní neladí.

## T2 – kostry pěti žánrů, `genre.v6`, kontrakt háčků

### Vstup klepnutím pro třídění a šipky: vstup pruhů, nový vstup `pick` nevznikl

- **Zjištění.** Záznam hry je `InputEvent` = `{ tick, buttons, axis }`; osa je celé číslo −1000..1000 a 0 znamená „bez vstupu“. Vstup pruhů (`genres/lanes/lanes-input.ts`) dnes čte jen vodorovnou polohu prstu: pět pásem, nebo hranice pruhů, které scéna zapíše do `data-lane-edges`.
- **Třídění** jde přes `lanes` beze změny: sloupec pod prstem je fronta. Scéna zapíše hranice front do `data-lane-edges`, ovládání čte `laneOfAxis`.
- **Šipky** jdou přes `lanes` s buňkou v ose: `axisOfCell(cell) = cell + 1` (`pieces/lanes.ts`), tedy mřížka do 999 buněk. Plátno buňku spočítá, když scéna zapíše `data-lane-cells` ve tvaru „sloupce,řady,vlevo,nahoře,vpravo,dole“ (hranice mřížky ve zlomcích plátna; `cellAxisAt`). Ťuk mimo mřížku nepošle nic. Bez atributu se vstup pruhů nemění, takže dosavadní žánry pruhů hrají stejně.
- **Proč ne `pick`.** Nový `Stage['input']` by potřeboval:
  - nový hook v `ArcadeStage.tsx` mimo větev výběru scény, což je mimo rozsah T2 a v souběhu s P64;
  - nový případ v mapě VR;
  - u pole `cell` nový formát záznamu i výzvy (`score/dare.ts`).

  Osa buňku unese beze změny formátu a hash her `genre.v5` se nehne.

### Sdílené registry (jednou, ať T5–T9 sahají jen na své soubory)

| Kde | Co přibylo |
|---|---|
| `genre/contract.ts` | `GENRES` (24), `GENRE_MODES`, varianty schématu, `FOE_DOES`, `COUNT_PARAMS`; `GENRE_COMPILER_VERSION = 'genre.v6'` |
| `genre/modules.ts`, `genre/<g>.ts` | pět modulů `stagedGenre` (meze parametrů pro počty z `COUNT_PARAMS`) |
| `genre/roles.ts` | `GENRE_FOE` (výchozí nepřítel podle žánru): goblin, car, robot, fruit, car. Jen slova, která `DEFAULT_LABELS` už má. Nové výchozí slovo by změnilo, které popisky z věty dostanou model (`_upgrade.ts`) a které se převlečou s místem (`compose.ts`), i u dnešních her. „guard“ shodil `goal-text.test.ts` u věty se strážcem. |
| `spec.ts` | ovládání `survivor`, `hole`, `steal`, `sort`, `arrows` v `CONTROLS` a `STAGED_CONTROLS` (čtečka je nenabízí), parametry ovládání |
| `capabilities.ts`, `draft/unsupported.ts`, `read/for-chain.ts` | řádky ovládání (typ `Record<ControlId, …>`); popisy vlastními slovy, bez jmen cizích her |
| `compose/stage-registry.ts` | `survivor`, `hole`, `steal` → vstup `arena`; `sort`, `arrows` → vstup `lanes`; scéna = jméno žánru |
| `compose/presets.ts` (`STAGED_PRESETS`), `intent/contract.ts` (`GENRE_ACTIONS`) | recepty koster: `autofire`, `swallow`, `steal`, `sort`, `unblock` – každá dělá z receptu celou hru (`wholeGame`), takže `assemble.ts` ani `recipe.ts` změnu nepotřebovaly |
| `arcade/library.ts` | ovládání `<g>`, robot `<g>_bot`, generátor (`survivor_waves`, `hole_swallow`, `steal_bases`, `sort_bins`, `arrows_grid`), pravidla `<G>_RULES` z `pieces/<g>.ts` a `<g>-bot.ts` |
| `arcade/pieces/mode-stub.ts` | `controlStub`, `botStub` a `modeStub` s vlastním ovládáním a robotem: generátor vrátí `issues`, takže svět nevznikne a hra neprojde publikační branou |
| `ArcadeStage.tsx` | jen větev výběru scény → `genres/<g>/<G>Scene.tsx` (podlaha `FieldGround`) |
| `draft/draft.ts` | `GENRE_SETTING` (ruined town, busy city, rival base, toy shop, parking lot); `TEMPLATE_TITLE` + `survivor`, `hole`, `heist`, `sort`, `arrows` – názvy modulů T5–T9 končí jedním z nich |
| `playwright.config.ts`, `e2e/play-<g>.spec.ts` | `pixel7-touch` dostal pět specifikací; `chromium` je bere sám (nejsou v `testIgnore`); každá zatím jeden `test.skip` |

Jména kusů, ovládání, generátorů a robotů drží úlohy žánrů beze změny. Přejmenování by znamenalo sahat do `library.ts`.

### Kontrakt háčků `arcade/hooks/contract.ts`

- `ROUNDS`: 1–5 kol, přestávka 90 tiků.
- `UPGRADES`: `speed`, `fire_rate`, `range`, `extra_life`, `magnet`, `carry`. K tomu `UPGRADE_STEP` (co dá jeden stupeň) a `UPGRADE_OFFER`: 3 karty, 300 tiků na volbu, výchozí karta 0, nejvýš 3 stupně.
- `RARITY`: váhy 70/25/5, násobič skóre ×1/×3/×10.
- `HOOK_SLOTS`: stav na těle-počítadle za tělesy úrovně – kolo, přestávka, nabídka, tiky na volbu, stupně vylepšení, nálezy. Vzácnost jednotlivé věci nese věc sama; kde přesně, rozhodne T3.
- **Volba karty je vstup:** nová tlačítka `BUTTON.PICK_1..3` (bity 11–13), které uložený záznam mít nemůže. `score/dare.ts` je přijme samo, protože masku tlačítek skládá z `BUTTON`.
- **Zprávy pro obrazovku** (`HookEffect` v `ArcadeEffect`): `score_pop`, `callout` (uzavřený seznam id), `round_start`, `round_clear`, `upgrade_offer`, `upgrade_pick`, `rare_found`, `boss_enter`. Stav nemění; jádro je jen propouští (1 řádek v `kernel.ts`), ověření je nehlásí (`verify.ts`).
- **Streamy** `upgrades`, `rarity`, `rounds` jsou připsané za `chain` v `src/sim/rng.ts`, takže dřívější streamy losují totéž.

### Šev na výšku `genres/portrait-first.ts`

- `fitTall(camera, box, rect)` vrátí `{ distance, shift }`:
  - `distance` = vzdálenost kamery od středu krabice po dosavadním směru pohledu;
  - `shift` = svislý posun v px pro `camera.setViewOffset(w, h, 0, shift, w, h)`.
- Pro perspektivu je fit přesný: každý roh krabice má svou hloubku. Mezi krabicí a hranou pásu zbývá okraj 8 px.
- Na `aspect ≥ 1` vrací vstupní pózu (`shift` 0).
- **Pás hry** se počítá z tokenů kitu, ne z DOM (`tokenRect`):
  - nahoře `HUD_BAND_PX` = 16 + 50 + 12 = 78 px;
  - dole `THUMB_ZONE_PX` = 16 + 62 + 12 + 62 + 12 = 164 px (dolní řada HUD a řada ovládání palcem).
- Tvar volání podle textu P64 T2. Soubor `portrait-frame.ts` ve worktree P64 28. 10. ještě nebyl, takže T14 musí tvar ověřit proti skutečnému souboru.

### Nálezy pro další úlohy

- **Joystick se na telefonu nekreslí.** Vizuální joystick (`TouchStick`) `ArcadeStage.tsx` ukazuje jen pro `move_free` a `fight`. Survivor, díra a krádež se ovládají tahem prstem kdekoli (`useArenaInput`), ale kroužek pod palcem chybí. Řádek leží mimo větev výběru scény (rozsah T2) a P64 ho přesouvá do zóny palce, proto → T14 po sloučení P64.
- **VR:** třídění hraje přes osu pruhů. Šipky (buňka ve 2D) páčka nevybere, takže T9 rozhodne, že je VR nenabídne.
- **Zmrazené výsledky po zvednutí na `genre.v6` byly přepočítané**, stejně jako v P51:
  - `evals/play/p41/golden/genres.json` (generátor `freeze.measure.ts -t "writes genres.json"`): rozdíl je jen 323× `compilerVersion` a 287× `specHash`; `replays.json` je bajt po bajtu stejný, takže svět ani robot nové hry se nepohnuly.
  - `evals/play/p41/difficulty.json` (`difficulty.measure.ts`): `specHash` se posunul u 35 z 62 buněk.
  - **Řádky běhů se změnily u šesti buněk** (`roam.catch`, `catch`, `whack`, `defense`, `slice`, `merge`; 40 řádků každá) a v souhrnu dvou z nich (`catch`, `merge`). Na T2 to nezávisí (inference):
    - spec `roam.catch` se nepohnul, a běhy přesto ano;
    - soubor se naposledy měřil v P54C (21. 10.) a P55 (události pruhů), P58A, P61 a P63 světy těch buněk změnily;
    - `difficulty.test.ts` řádky nehlídá, jen `specHash` a meze.
- **`GENRE_COMPILER_VERSION` má typ `string`.** S doslovným typem by stráž `!== 'genre.v5'` v `p66-hash.test.ts` po zvednutí verze neprošla `tsc` ani buildem.
- **Soubory mimo seznam T2, které typy nebo testy vyžádaly:**
  - `verify.ts` – vyčerpávající `switch` efektů;
  - `kernel.ts` – zprávy háčků stav nemění;
  - `read/for-chain.ts`;
  - `pieces/lanes.ts` a `lanes-input.ts` – buňka v ose;
  - `sim/rng.ts` – streamy;
  - testy, které čekaly 19 žánrů, verzi `genre.v5` nové hry nebo volný bit 12:
    - `doubles.ts`, `hero-animals.test.ts`, `dressing.test.ts` (jen žánry, které hrají);
    - `pacing-template`, `p51-assembly-runner`, `p51-dead-time`, `p52-fight-balance` (nová hra je `genre.v6`);
    - `chain/__tests__/run.test.ts` (`chain` už není poslední stream);
    - `score/__tests__/dare.test.ts` (cizí tlačítko je bit 20);
    - `p56a` a `p58b` – zapečetěné sady před P66, nové žánry v nich být nemůžou;
  - `e2e/p61-portrait.spec.ts`: kostru přeskočí, protože hru nepostaví.
- **Testy:**
  - `npx vitest run src/play/genre src/play/arcade src/play/compose src/components/play/arcade` zelené po opravách; první běh měl 334 červených, z toho 323 v zmrazených specech `presets.test.ts`;
  - druhá dávka `src/play/__tests__`, `chain`, `director`, `read`, `xr`, `draft`, `score`, `intent`, `fidelity`, `src/sim`, `evals/play/{p41,p47a,p54c,p56a,p58b}` zelená;
  - otisk T1 `p66-hash.test.ts` zelený (48/48);
  - `tsc --noEmit` čistý.
