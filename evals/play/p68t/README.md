# P68T – druhé kolo směrování: zapečetěná sada

Sada P68R je od T6 (3. 11.) otevřená a P68T na ní ladí směrování `railfps`, `buildshift` a `drawsave`, takže verdikt
musí dát nová sada. T1 ji napsal a zapečetil 4. 11. **před** první změnou `src/play/genre/classify.ts` v P68T;
otevře ji jednou T3.

## Sada

- 90 vět: 15 na každou ze tří her pod prahem P68R (`railfps`, `buildshift`, `drawsave`), 15 na `minigolf` (práh
  splnil a nesmí klesnout) a 30 obecných přes 22 dosavadních žánrů (rozpis P68R: `voyage` 3, `platformer`, `runner`,
  `shooter`, `throw`, `quest`, `defense` po 2, zbylých 15 po jedné). Tvar jako `p68r/holdout.json` (`id`, `half`,
  `genre`, `game`, `text`); čtyři hry mají `half: "new"`.
- Slepé štítky ve tvaru `p68r/holdout-labels.json` (`best`, `acceptable`, `aimed`): stejný soudce, otázka a 29 typů jako
  `p68/genre-labels.json`, seed 68201. Oštítkované hned při zapečetění, takže verdikt nezávisí na ničem, co vzniklo po
  ladění.
- **Mimo repo:** `D:/caches/p68t/sealed/holdout.json` a `holdout-labels.json` (kopie
  `F:/Backups/Hackaton/2026-11-04/p68t-holdout.json` a `p68t-holdout-labels.json`; `P68T_SEALED_DIR` přepíše složku).
- Otisky (SHA-256 nad LF bajty) v `seal.ts`:
  - sada `a3875ef969fb76eee7edf1625e1f5996fe7b1d716ef678fff02d38093e5c6935`
  - štítky `a469a4e7b4e125c3fccc4dd5cf202a3f27826c2fb4e72a603177f9573c101186`

## Jak vznikla

`write-sealed.mjs`: věty napsal `claude -p` (`claude-opus-5-5`, `--safe-mode`, bez nástrojů) v prázdném `mkdtemp`.
Viděl jen popis typu hry slovy (`p68/genre-labels.mjs`) a řádek pro režiséra (`director/prompt.ts`) s pokynem psát
jako různí hráči na telefonu (děti, rodiče, hráči, kdo angličtinu nemá jako první jazyk, malá písmena bez interpunkce),
různě dlouze, s méně samozřejmými hrdiny, místy a tématy mimo příklady a třetinu vět bez jména typu hry. Kód
směrování ani otevřené sady neviděl. Věty shodné se známou sadou (`knownSets()` v `seal.ts`: seznam P68R + otevřená
`p68r/holdout.json`) nebo mezi sebou skript zahodil (1 746 známých vět, 162 napsaných, 90 vybraných v pořadí
odpovědi, 10 volání, 0 selhání). Skript vypisoval jen počty a otisky – kdo ladí směrování, věty neviděl. Existující
sadu nepřepíše.

## Pravidla

- Na sadě se nic neladí. Otevře ji jednou T3 přes `openSealedOnce(SEALED_DIR, P68T_HOLDOUT_SHA256, …)`, který zapíše
  `holdout-opened.json`; druhé otevření odmítne.
- Test pečeti `__tests__/seal.test.ts`: kde sada je, hlídá oba otisky (i v tomto README), složení, štítek pro každou
  větu a žádnou shodu se známými sadami; všude hlídá, že známé sady obsahují otevřenou sadu P68R, holdout a dev P68.

## T3 – výsledek na sadě (4. 11.)

Sada je od T3 **otevřená** (`holdout-opened.json`) a leží i v repu (`holdout.json`, `holdout-labels.json`, otisky
sedí s pečetí). Další plán, který na ní bude ladit, ji musí přidat mezi známé sady své pečeti. Výsledek je
v `result.md`, surová čísla v `result.json`, přepočet v `__tests__/result.test.ts`.

Postup (jako P68R T6, jen G1 a G2):

- **Strany:** `main` = `0d432d79` (rodič commitu pečeti `7fe5c421`, stav před P68T, `D:/caches/p68t/main-0d432d79`),
  větev = `origin/main` `17c85b15` po T2 (#87). Prahy z `p68/gates.json`.
- **G1:** `node evals/play/p68/genre-route.mjs [--root <main>] --labels evals/play/p68t/holdout-labels.json --out
  route-holdout-{main,branch}.json`; obecné věty a sada 200 přes štítky P68 T2 (`route-{main,branch}.json`). „Svou
  hru“ = žánr skladatele (`draftGameSpecWithMeta(věta, 1)`).
- **G2:** `scripts/measure/gameplay-gate.mjs` nad specem rychlé hry každé nové věty (seed 1); věta poslaná do jiné
  hry je ve jmenovateli jako selhání. Zpráva `gameplay-holdout.json`.
