# P68R – směrování vět na nové hry: zapečetěná sada

Holdout P68 je od T15 (3. 11.) otevřený a P68R na něm ladí směrování, takže verdikt o směrování musí dát nová sada.
T1 ji napsal a zapečetil 3. 11. **před** první změnou `src/play/genre/classify.ts` v P68R; otevře ji jednou T6.

## Sada

- 105 vět: 15 na každou novou hru (`stunt`, `minigolf`, `railfps`, `buildshift`, `drawsave`) a 30 obecných přes
  22 dosavadních žánrů (`voyage` 3, `platformer`, `runner`, `shooter`, `throw`, `quest`, `defense` po 2, zbylých 15 po
  jedné). Tvar jako `p68/holdout.json` (`id`, `half`, `genre`, `game`, `text`).
- Slepé štítky ve tvaru `p68/holdout-labels.json` (`best`, `acceptable`, `aimed`): stejný soudce, otázka a 29 typů jako
  `p68/genre-labels.json`, seed 68101. Oštítkované hned při zapečetění, takže verdikt nezávisí na ničem, co vzniklo po
  ladění.
- **Mimo repo:** `D:/caches/p68r/sealed/holdout.json` a `holdout-labels.json` (kopie
  `F:/Backups/Hackaton/2026-11-03/p68r-holdout.json` a `p68r-holdout-labels.json`; `P68R_SEALED_DIR` přepíše složku).
- Otisky (SHA-256 nad LF bajty) v `seal.ts`:
  - sada `2a62edae56cdb9c4536584b917af1d5dd4753d91bc3ab54f13dcfb841cb5d939`
  - štítky `35bbda7cc2d25737d83f5536fc6cef43e258fbacfb2721d2c5f003de7c85bccd`

## Jak vznikla

`write-sealed.mjs`: věty napsal `claude -p` (`claude-opus-5-5`, `--safe-mode`, bez nástrojů) v prázdném `mkdtemp`.
Viděl jen popis typu hry slovy (`p68/genre-labels.mjs`) a řádek pro režiséra (`director/prompt.ts`, u `stunt`
`p68/vozidla-sport/integration.md`) s pokynem psát jako hráči na telefonu, různě dlouze, s hrdiny, vozidly a místy
mimo příklady a třetinu vět bez jména typu hry. Kód směrování, dev sadu ani otevřený holdout neviděl. Věty shodné se
známou sadou (`knownSets()` v `seal.ts`: seznam P68 + otevřený `p68/holdout.json`) nebo mezi sebou skript zahodil
(1 641 známých vět, 184 napsaných, 105 vybraných v pořadí odpovědi). Skript vypisoval jen počty a otisky – kdo ladí
směrování, věty neviděl. Existující sadu nepřepíše.

## Pravidla

- Na sadě se nic neladí. Otevře ji jednou T6 přes `openSealedOnce(SEALED_DIR, P68R_HOLDOUT_SHA256, …)`, který zapíše
  `holdout-opened.json`; druhé otevření odmítne.
- Test pečeti `__tests__/seal.test.ts`: kde sada je, hlídá oba otisky (i v tomto README), složení, štítek pro každou
  větu a žádnou shodu se známými sadami; všude hlídá, že známé sady obsahují otevřený holdout a dev sadu P68.

## T6 – výsledek na sadě (3. 11.)

Sada je od T6 **otevřená** (`holdout-opened.json`) a leží i v repu (`holdout.json`, `holdout-labels.json`, otisky
sedí s pečetí). Další plán, který na ní bude ladit, ji musí přidat mezi známé sady své pečeti. Výsledek je
v `result.md`, surová čísla v `result.json`, přepočet v `__tests__/result.test.ts`.

Postup (stejný jako P68 T15, aby šel přeměřit):

- **Strany:** `main` = `188d44e9` (rodič commitu pečeti `58f09a6e`, stav před P68R, port 3181,
  `D:/caches/p68r/main-4a5d859c`), větev = `origin/main` `dded82df` po T5 (port 3180). Prahy z `p68/gates.json`.
- **G1:** `node evals/play/p68/genre-route.mjs [--root <main>] --labels evals/play/p68r/holdout-labels.json --out
  route-holdout-{main,branch}.json`; obecné věty a sada 200 přes štítky P68 T2 (`route-{main,branch}.json`). „Svou
  hru“ = žánr skladatele (`draftGameSpecWithMeta(věta, 1)`), tedy hra, kterou hráč dostane.
- **G2:** `scripts/measure/gameplay-gate.mjs` nad specem rychlé hry každé nové věty (seed 1); věta poslaná do jiné
  hry je ve jmenovateli jako selhání (`failed: "routed to …"`). Zpráva `gameplay-holdout.json`.
- **G3:** `@p68-fps` (`e2e/play-perf.spec.ts`, ruční spec každé hry, kontrola `p66-arrows`) proti sestavě větve,
  `pixel7-touch` hradí, `iphone-touch` jen zapisuje. Soubor `fps-holdout.json`.
- **G4:** jen `buildshift` (zapojený v T5): první 3 nové věty podle id, které rychlá hra větve pošle do hry, × 3 běhy,
  desktop + `pixel7-cpu4`. `minigolf`, `railfps` a `drawsave` se od T15 nezměnily, jejich běhy test bere
  z `p68/result.json`. `stunt` nezapojený, bez běhů.
- **G5:** `p66-hash`, `p66-hooks-existing`, `p68-hash`, `p68-roundtrip` – počty v `result.json`.
- **G6, G7 se neměří:** G6 je druhotná a hru, která neprojde G1–G5, nezachrání; G7 by stála peníze (plán P68R je bez
  útraty) a v T15 poskytovatel režiséra vracel 429.
