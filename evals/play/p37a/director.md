# P37A T8 – vyhraje AI verze nad návrhem?

Lokální gpt-oss-20b (llama.cpp, RTX 3090) jako kompaktní režisér nad `dev-150.json`, commit `d6bde059`, 2026-10-04. Vygenerováno skriptem `director.measure.ts`, data v `director.json`. Robot publikace se nepouštěl.

| | počet | podíl ze 150 |
|---|---|---|
| AI verze došla k bráně (model odpověděl, hra se liší od návrhu) | 144 | 96 % |
| **AI verze vyhraje nad návrhem o ≥ 0.05** (ruční seznam) | **42** | **28 %** |
| AI verze prohraje o ≥ 0.05 (ruční seznam) | 27 | 18 % |
| brána by AI verzi nabídla (seznam z věty) | 20 | 13.3 % |

- **Průměrný zisk AI verze** nad návrhem (věty, kde došla k bráně): 0.01 na ručním seznamu, -0.067 na seznamu z věty.
- **Shoda brány s ručním seznamem:** nabídla a vyhrála 13, nabídla bez výhry 7, zastavila výhru 29, zastavila nevýhru 95.
- **Co hráč skončí hrát** (průměrná věrnost na ručním seznamu přes všechny věty): jen návrh 0.634, AI verze vždy 0.644, s bránou 0.651.
- Bez AI verze: MALFORMED 2, UNCHANGED 4.
- **Latence režiséra – lokální RTX, ne produkce:** p50 2084 ms, p95 5206 ms, max 27038 ms. Produkce je gpt-oss-20b přes Groq a změří ji P30A T9/T10.

## Rozbor (dopsáno ručně k běhu `d6bde059`)

Fakta z `director.json`:

- Brána zastavila 25 z 27 AI verzí, které by hráči věrnost snížily. Proto je hra s bránou (0,651) věrnější než AI verze vždy (0,644).
- Brána zastavila i 29 skutečných výher. U 28 z nich má AI verze na seznamu z věty zisk přesně 0: přidala jméno, které ruční seznam má a seznam z věty ne.
- Ze 7 nabídnutých verzí bez výhry je 5 vět mimo hry (n07, n19, n28, n33, n38). Tam seznam z věty jmenuje kulisu nebo chvíli („long queue“, „hour“), ne věc, kterou by ruční seznam čekal.

Odhad (inference): seznam z věty bere podstatná jména jen z popisků návrhu a z `readRoles`. Jméno, které návrh přehlédl, na seznamu chybí, a AI verze za něj proto bod nedostane. Víc výher pustí bohatší seznam z věty (každé podstatné jméno věty, ne jen popisky návrhu), ne nižší práh: při nulovém zisku by práh 0,0 pustil i stejně věrné verze.
