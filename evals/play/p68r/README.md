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
