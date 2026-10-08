# P44C – zapečetěná sada, jediné otevření (T14)

Otevřeno 8. 10. 2026 14:15 UTC nad `c18715c1`, SHA sady `1113be1a…` sedí na pečeť (`sealed-opened.json`).
Jeden běh, `PLAY_VOCAB=off` i `on` nad týmž commitem, 114 vět (55 `unknown-verb`, 32 `fantasy`, 15 `non-game`, 12 `control`).
Data po větách: `result.json`. **Splněné 2 z 5 cílů.** Cíle se nepřepisují a podle sady se nic neladí.

| Míra | Cíl | Bez tabulky | S tabulkou | Splněno |
|---|---|---|---|---|
| **U** – `unknown-verb` věty, jejichž trojici hra hraje (svědek) | ≥ 48 % | 9/55 (16 %) | 11/55 (20 %) | ne |
| **F1** – totéž pro `fantasy` | ≥ 50 % | 19/32 (59 %) | 19/32 (59 %) | ano (tabulka nic nepřidala) |
| **F2** – fantasy podstatná jména kreslená modelem (`offlineChain`, `ok`) | ≥ 50 % | 27/62 (44 %) | 27/62 (44 %) | ne |
| **N** – `non-game` bez falešného mapování | 100 % | 15/15 | 15/15 | ano |
| **H** – věta s namapovaným slovesem má přiznání `played_as` / `actions` | 100 % | – | 9/10 | ne |
| `control` – zachované věty proti `off` | beze změny | 8/12 | 8/12, žádná změna | ano |

## Proč U nedošlo (fakta z `result.json` a sondy nad sadou po otevření)

Z 55 vět `unknown-verb` je 11 hraných, 7 namapovaných a nehraných, 37 bez namapovaného slovesa.
Sloveso z věty („said“ ve štítku) u vět bez mapování:

| Příčina | Vět | Příklady |
|---|---|---|
| detektor sloveso vidí, tabulka ho nezná | 22 | headbutt, pluck, swat, slice, scoop, swipe, hook, bowl, juggle, zigzag |
| tabulka sloveso zná, detektor ho ve větě nenajde | 12 | hoard, plunder, serve, zap, shove, stalk, fetch, sneak, chase, fly, steal |
| detektor vidí jiné slovo než to ze štítku | 3 | chop, carve, burrow |
| ani jedno | 8 | slingshot, pound, somersault, douse, drop, split, slap, torch |

Namapované, ale hra je nehraje (7): `bikes→deliver`, `jabs→fight`, `vaults→jump`, `scuttles→roam`, `pelts→shoot`,
`nudges→deliver`, `salvages→collect` – osa sedí, návrh ale postaví hru, která tu trojici nedokáže svědkem.

**Jedna věta se s tabulkou zhoršila:** s44c-044 „a diver salvages treasure from a sunken galleon“ – bez tabulky hra
sběru (štítek chce `collect`, splněno), s tabulkou „salvage“ → interakce, hra interakce a sběr nedokáže. Tabulka
mapuje „salvage“ přes WordNet k „save/rescue“, ne ke sběru.

## Proč F2 nedošlo

62 fantasy podstatných jmen: 27 nakreslených, 19 bez modelu (`no-model`), 12 nedošlo do specu (`not-in-spec`),
4 ovládání nečte. Rozšíření `nearest.json` o 2128 jmen OEWN na sadě nic nezměnilo: fantasy jména buď katalog už
kreslí, nebo nemají model se skóre ≥ 0,5 (jako „wyvern“) – tabulka nejbližšího modelu je nevyrobí.

## H

s44c-030 „scuttles“ (namapované na `roam`) dostane přiznání `no_verb` místo `played_as` – věta nemá jiné herní
sloveso a třída `no_verb` v `honesty` přebije přiblížení.

## Odvozeno (inference, ne měření)

- Hlavní brzda U je **pokrytí tabulky** (metoda A @ 0,4 má na zlaté sadě pokrytí 37,8 %) a **detektor neznámých
  sloves** v `extract.ts`, který sloveso ve větě nenajde (12 vět, které tabulka zná). Oba kroky jsou mimo tenhle plán;
  P44C je nesmí ladit podle této sady.
- F2 nehne tabulka, ale nové modely v knihovně (P43/P44E) nebo serverové rozhodnutí modelu v návrhu.
