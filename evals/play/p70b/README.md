# P70B – věta dá svou postavu a svůj sport: zapečetěná sada

Audit 4. 11. našel dvě stížnosti majitele: zvíře z věty není hrdina (králík 16/20) a golf nehraje minigolf (13/20).
T2 a T3 ladí na větách auditu (`dev.json`, 20 králík + 20 golf) a na otevřených sadách P68, P68R a P68T, takže verdikt
musí dát nová sada. T1 ji napsal a zapečetil 4. 11. **před** první změnou směrování (`src/play/genre/classify.ts`)
a výběru modelu (`src/play/arcade/models.ts`) v P70B; otevře ji jednou T5.

## Sada

- 70 vět ve tvaru `p68t/holdout.json` (`id`, `half`, `genre`, `text`):
  - `half: "animal"` – 30 vět, ve kterých je zvíře z knihovny hrdinou: 15 druhů s riggovaným modelem (králík 4, kočka,
    pes, tučňák, lední medvěd, liška, vlk, kůň, kráva, jelen, panda, slepice, krab po 2, alpaka a osel po 1; rozpis
    `ANIMAL_COUNTS` v `seal.ts`). Navíc `hero` (druh) a `heroModels` (riggované modely, které za druh platí, `ANIMALS`).
    `genre` = typ hry, na který věta míří.
  - `half: "golf"` – 20 vět na golf (`genre: "minigolf"`): holé slovo, tvar -ing, neobvyklé místo, zvíře nebo
    postava, překážky; jen pár říká mini golf nebo putt.
  - `half: "general"` – 20 obecných přes 14 žánrů před P68 (`GENERAL_COUNTS`).
- Slepé štítky ve tvaru `p68t/holdout-labels.json` (`best`, `acceptable`, `aimed`, u zvířat i `hero` a `heroModels`):
  stejný soudce, otázka a 29 typů jako `p68/genre-labels.json`, seed 70201. Oštítkované hned při zapečetění.
- **Mimo repo:** `D:/caches/p70b/sealed/holdout.json` a `holdout-labels.json` (kopie
  `F:/Backups/Hackaton/2026-11-04/p70b-holdout.json` a `p70b-holdout-labels.json`; `P70B_SEALED_DIR` přepíše složku).
- Otisky (SHA-256 nad LF bajty) v `seal.ts`:
  - sada `53351a03dcb64073137980095401905730da210ce6ea53a2b35c05e766ace371`
  - štítky `c0cbf7360d111c08332e740029a7695b02b7637212e9b6fbfb4efd6d2e2c1b0d`

## Jak vznikla

`write-sealed.mjs`: věty napsal `claude -p` (`claude-opus-5-5`, `--safe-mode`, bez nástrojů) v prázdném `mkdtemp`.
Viděl jen jména zvířat, popis typů her slovy (`p68/genre-labels.mjs`) a pokyny ke stylu (různí pisatelé na
telefonu; u zvířat třetina vět se zvířetem za slovesem – „help / guide / feed the …“, „save the baby …“ –, část bez
členu na začátku, množné číslo, mládě nebo synonymum, zvíře, které brání svůj domov). Kód ani otevřené sady neviděl.
Věty shodné se známou sadou (`knownSets()` v `seal.ts`: seznam P68T + otevřená `p68t/holdout.json` + věty auditu
`dev.json`) nebo mezi sebou skript zahodil (1 876 známých vět, 121 napsaných, 51 zahozených, 70 vybraných v pořadí
odpovědi, 7 volání, 0 selhání, 156 s). Skript vypisoval jen počty a otisky – kdo ladí, věty neviděl. Existující sadu
nepřepíše.

## Pravidla

- Na sadě se nic neladí. Otevře ji jednou T5 přes `openSealedOnce(SEALED_DIR, P70B_HOLDOUT_SHA256, …)`, který zapíše
  `holdout-opened.json`; druhé otevření odmítne.
- Hrdina správně = model hrdiny, kterého vykreslí rychlá hra věty (seed 1), je jeden z `heroModels` věty.
- Test pečeti `__tests__/seal.test.ts`: kde sada je, hlídá oba otisky (i v tomto README), složení, štítek se stejným
  hrdinou pro každou větu a žádnou shodu se známými sadami; všude hlídá seznam známých sad (včetně vět auditu a
  otevřené P68T) a že každý model v `ANIMALS` je riggovaná postava s tagem svého druhu.
