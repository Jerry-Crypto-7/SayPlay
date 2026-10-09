# P45C – měřidlo průběhu hry

Měří, jestli hra má úvod, stupňování a finále: stoupá tlak hrozeb od začátku ke konci běhu, nese hra finále a kolik různých chování nepřátel v ní je. Čte jen stav jádra a kusy světa, telemetrii P45A ne – P45A definuje „mrtvý čas“ a „finále“ po svém a T17 obě definice porovná.

```
npx vitest run --config vitest.measure.mts evals/play/p45c/pacing.measure.ts                 # → baseline.json
P45C_OUT=after npx vitest run --config vitest.measure.mts evals/play/p45c/pacing.measure.ts  # → after.json
```

Každá živá buňka (`liveCells`) × semínka 1–8, týž svět jako `/play` (`compileRecipe` → `arcadeWorldOf`). Kód: `pacing.ts`, test měřidla `__tests__/pacing-gauge.test.ts`.

## Pole řádku

| Pole | Co znamená |
|---|---|
| `threatsPerThird` | průměrný tlak (m/s) v první, druhé a třetí třetině **běhu robota intermediate** (ne horizontu 90 s). Tlak tiku = součet rychlostí živých těl rolí `chaser`, `enemy`, `hazard`; rychlost = posun mezi dvěma tiky. Tělo, které tik předtím nežilo (předloha, právě oživené), a přesun nad 30 m/s (nová vlna na vstupu) se nepočítají |
| `countPerThird` | průměrný počet živých hrozeb po třetinách |
| `rising` | poslední třetina má tlak aspoň o 15 % vyšší než první (a nenulový) |
| `finale` | svět nese bosse (`boss_beat`) nebo pravidlo `pacing` s finále |
| `behaviours`, `behaviourNames` | různá chování nepřátel ve světě: dnešních šest (`wander-flee`, `pursue`, `pursue-track`, `fight`, `guard`, `pendulum` – definice v `behavioursOf`) a nová P45C z obalu `pacing_control` a `boss_beat` |
| `winSeconds` | sekundy do výhry robota intermediate; `null` = nevyhrál |
| `noviceWon`, `intermediateWon` | výhra robota s profilem člověka (`BOT_PROFILES`, `verify.ts`) |
| `idleWon` | nečinný hráč vyhrál (`verifyArcade`) |
| `replayEqual` | přehrání záznamu robota intermediate dá týž hash a `verifyArcade` hlásí shodu dvou přehrání |
| `buildMs` | `compileRecipe` + `arcadeWorldOf` + `verifyArcade` v ms (načtení Rapieru mimo) – jediné pole, které se mezi běhy mění |

**Role `projectile` se nepočítá:** v jádře ji má jen výstřel hráče (`blaster`, `gun`, `launch`), takže hod (`throw.default`) by ve všech 8 semínkách „stoupal“ jen tím, že hráč háže. Výstřely nepřátel P45C (ostřelovač, boss) jsou role `hazard`.

## Baseline na `main` (`0714a352`, 8. 10. 2026)

`baseline.json`, 54 živých buněk × 8 semínek = 432 her, všechny postavené bez chyby.

| Měřítko | Baseline |
|---|---|
| Tlak stoupá (`rising`) | **9 %** her – jen buňky s vlnami (`arena.escape`, `arena.collect`, `arena.escape+collect`, `quest.spatial` 8/8) a souboj (`arena.fight` 6/8) |
| Finále | **0 %** |
| Chování nepřátel, medián | **0** (nejvýš 1 na hru: `pursue`, `pursue-track`, `guard`, `fight`, `wander-flee`, `pendulum`) |
| Novice 0,3–0,7 | 27 z 54 buněk; nad 0,7 je 20 (`drive.*` a `voyage.race` 1,0, `glide.*`, `ball.*`, `roam.catch`, `jump.escape`, `flap.collect`, `arena.escape+collect` 0,75), pod 0,3 je 7 (`platformer.*`, `timing.*` 0,25) |
| Intermediate ≥ 0,8 | 54 z 54 buněk |
| Délka 30–90 s (výhry intermediate) | 64 % – krátké jsou `walk.*` (12 s), `glide.*` (15 s), `ball.*` (10–16 s), `voyage.land` (14 s), `roam.catch` (6 s) |
| Nečinný vyhrál | 0 |
| Přehrání = hash | 100 % |
| `buildMs` p95 | 761 ms |

## T13 – střelnice, souboj dvou, míč

- **Střelnice:** vlny čekají za branou 40 m (mimo dostřel) a vyjdou podle pochodu, jehož rozestupy zhušťuje křivka; ostřelovač od druhé vlny; finále boss-terč s HP 5 a salvou, kterou jde sestřelit. Buňka P41 `shooter.default` (jeden život) průběh nedostane vůbec: proniklý výstřel prohraje celou hru a začátečník s průběhem vyhrával 0,85–1,0 místo 0,7 (s bossem i jen s poslední vlnou jako finále) – páka jen na začátečníka se nenašla, náboje i rychlost salvy jsou útes i pro robota bez profilu.
- **Souboj dvou:** agresivita soupeře jde s intenzitou (700–1200) místo zrychlení po soupeřích; finále = rozzuření posledního soupeře pod polovinou HP (nápřah +12 tiků, mezera −4). Soupeř stojí a scéna ho kreslí na startu, takže tlak tohoto měřidla je u souboje vždy 0 – stoupání souboje měří test četností úderů po třetinách.
- **Míč bez průběhu:** spec míče staví `nativeSpec` bez `genre` (jako chodec), takže záznam by nikdy neběžel; volba finále podle módu `ball_pitch` (s brankářem boss-brankář, bez něj pohyblivá branka – bez soupeře není koho porazit) čeká na značku nové hry i pro nativní spec.
