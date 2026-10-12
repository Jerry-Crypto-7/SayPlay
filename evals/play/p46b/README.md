# P46B – úseky a boss pro běžce, řízení a skákačku

Měří, jestli hra těchto tří žánrů má rozjezd, dva úseky, které něco mění, a finále. Vedle čísel zábavy P45A (mrtvý čas, stoupání, finále, chování) přidává `segmentChanges` – kolik z úseků 2 a 3 přineslo proti předchozímu hratelnou změnu.

```
npx vitest run --config vitest.measure.mts evals/play/p46b/segments.measure.ts                  # → baseline.json
P46B_OUT=after npx vitest run --config vitest.measure.mts evals/play/p46b/segments.measure.ts   # → after.json
npx vitest run evals/play/p46b/__tests__/segments-gauge.test.ts                                 # test měřidla
```

**Věty:** z panelu P45 ty, které rychlý návrh postaví jako běžce (`runner`), řízení (`control:steer`) nebo skákačku (`platformer`) – 8 vět – a 12 nových v `sentences.json`, 4 na žánr (prvních šest jsou věty majitele z 12. 10.). Každá věta na semínku, které vybere publikace (`publishedWorld` v `p45/fun.ts`, táž cesta jako `/play`), běh robota `intermediate`. Souhrn buňky bere jen hratelné hry, které opravdu postavily žánr své buňky (`offGenre` = které ne).

## Měřidlo úseků (`segments.ts`)

Úseky jsou `PACING.segments` nad postupem hráče po trati (`z / length` v promile, nejvyšší dosažený): rozjezd 0–200, úsek 2 200–650, úsek 3 650–850, finále 850–1000. Úsek 2 se porovná s rozjezdem, úsek 3 s úsekem 2. Hratelná změna je jen:

| Změna | Kdy | Proč takhle |
|---|---|---|
| `foe:<role>:<pohyb>` | hrozba (`chaser`, `enemy`, `hazard`) s podpisem role + pohyb (`static`, `chase`, `roam`), který žádný dřívější úsek neměl | model ani barva v podpisu nejsou – nový vzhled téhož chování není změna (test) |
| `terrain:<role>:<static\|moving>` | nový druh těla trati (`obstacle`, `platform`), např. pohyblivá plošina | |
| `width:a->b` | medián volné šířky mezi dlouhými stěnami (≥ 10 m, mantinely řízení) se liší o ≥ 10 % | řady běžce nejsou stěny |
| `speed:a->b` | medián rychlosti hráče vpřed je o ≥ 10 % **vyšší** | medián: krátké turbo řízení úsek nezmění; jen růst: robot skákačky na těžší trati zpomalí, a to není nové tempo |
| `density:a->b` | překážek a hrozeb poprvé viděných na 100 m je ≥ 1,5× **víc** a aspoň o 2 víc | jen růst: řidší úsek nic nepřináší; dva soupeři řízení na startu jsou rozestavění, ne stupňování |

Zorné pole je 40 m před hráčem a 5 m za ním. Plošiny a dlouhé stěny do hustoty nejdou (tvar trati, ne co hráč míjí). Finále měří `finale` telemetrie P45A, ne `segmentChanges`.

## Baseline (`baseline.json`, `features/P45-demo-2026-10-12` `491079b7`)

| Buňka | Hratelné | Mrtvý čas (medián, s) | `rising` | `finale` | Chování (medián) | `segmentChanges` medián | `segmentChanges ≥ 2` |
|---|---|---|---|---|---|---|---|
| běžec | 6/6 | 9,36 | 1 | 0,67 | 1,5 | 2 | 1 |
| řízení | 7/7 | 9,92 | 0,86 | 0 | 1 | 1 | 0,29 |
| skákačka | 7/7 | 9 | 0 | 0 | 1 | 1 | 0 |

- **Běžec úseky už mění** (hrozby R2 od úseku 2, hejno od vrcholu, fáze rychlosti, hustší řady). Chybí mu boss (finále 0,67 je stupňování na konci, ne boss) a mrtvý čas.
- **Řízení** mění jen úsek 2 (zúžení trati z 10 m na 3,8 m a krok rampy +10 %), úsek 3 nic. Bez finále.
- **Skákačka** mění jen úsek 2 (pohyblivá plošina, hustší hroty), úsek 3 nic, intenzita nestoupá a finále nemá.
- Pět her má mrtvý čas přesně 10 s – první herní událost přijde až v 10. s (pravděpodobně první vlna šablony pravidel; ověří T2).

## T6 – skákačka: úseky a boss (12. 10.)

**Záložní plán z plánu se nepoužil**: robot skákačky plánuje skoky rychlostí úseku (`speed` v parametrech ovládání i robota, fáze ji škálují), takže skákačka má úseky i se změnou rychlosti a finále s bossem.

- **Jen nová hra.** Žánr Skákačka píše do `tuning` značku `segments`; jen s ní generátor staví úroveň po úsecích průběhu (`PLATFORM_SEGMENTS`) a `GENRE_PACING.platform_level` ji pace. Uložená hra bez značky, `genre.v1` i fixtura staví tentýž svět. Útěk s jedním životem (`jump.escape`) značku ani průběh nedostane: dotek bosse končí hru a začátečník vyhrál s finále 115 % 7/16, se 100 % 15/16 – útes, ne páka.
- **Úseky:** rozjezd o stupeň lehčí (90 %), úsek 2 od 450 ‰ past (hrot, který vyjíždí ze země a zajíždí) a pohyblivá plošina (100 %) – obojí až za 40 m zorného pole měřidla od konce rozjezdu –, úsek 3 rychlejší (115 %), finále aréna 20 m s checkpointem (100 %).
- **Boss `brute`** (nové chování na konci `BEHAVIOUR_IDS`): pevné tělo role `hazard`, 3 HP. Dotek z boku zraní jako hrot, doskok na hlavu mu ubere 1 HP a omráčí ho na 45 tiků; po varování 40 tiků (−4 za zásah) nabíhá na zamčené místo hráče. Výhru nedá, padne třetím doskokem.
- **Mrtvý čas:** mince u hrany, kde se čeká na pohyblivou plošinu, a mince, která jede s ní; mince rozložené po celé trati (dřív je rozpočet 60 vyčerpal úvod); rozjezd jen prostřední mince (hra k finále houstne).

| Měřeno | Před | Po |
|---|---|---|
| Měřidlo T1, skákačka (7 vět): mrtvý čas medián | 9 s | 2,77 s |
| `rising` / `finale` / `segmentChanges ≥ 2` | 0 / 0 / 0 | 1 / 0,86 / 0,86 |
| 4 buňky `platformer.default*`, semínka 1–20: novice / intermediate | 0,30 / 1,0 | 0,45 / 0,45 / 0,35 / 0,35 · 1,0 |
| Test T6 (semínka 1–8, intermediate): mrtvý čas | – | ≤ 3,62 s, boss padl v každé výhře |

Nalezeno, nevyřešeno: věty se sbíráním všeho (`collectAll`, např. „collecting bananas“) mají jen věci z věty a mrtvý čas 9,5–15,5 s (mince navíc by se staly povinnými). Věta „obby game with lava and spinning bars“ boss ani změnu úseku 3 v měřidle nemá (důvod neověřen; měřidlo výsledek běhu nezapisuje).
