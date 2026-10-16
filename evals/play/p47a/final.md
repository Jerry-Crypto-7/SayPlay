# P47A – konečné měření na novém holdoutu (16. 10. 2026)

Holdout `evals/play/p47a/holdout.json` (60 vět, které napsal nezávislý subagent) otevřený poprvé `2026-10-16T09:05:17.553Z`; otisk SHA-256 nad LF bajty ověřen před čtením obsahu: `7f62855dd8f45ad6ab1f050aea403ad76030b5c9163c6bedef643cdddbd9bd79` (shoda s otiskem ze vzniku sady). A = `abe38f04` (základ větve, `genre.v3`), B = `4e806213` (HEAD větve, `genre.v4`), obojí týmž měřidlem (`finale.measure.ts` s `P47A_HOLDOUT=1`), robot `intermediate`, semínko publikace. Měří se rychlá verze; po otevření holdoutu se nic neladilo. Zapečetěná sada P45 se nečetla.

| Cíl (holdout, 60 vět) | Splnit | A | B | Splněno |
|---|---|---|---|---|
| Finále nebo boss | ≥ 0,8 | 0,37 | **0,72** | ne |
| Chování nepřátel, medián | ≥ 2 | 1 | 2,5 | ano |
| Mrtvý čas (nejdelší mezera), medián | ≤ 3 s | 4,47 s | 2,99 s | ano |
| Stoupání | ≥ 0,7 | 0,53 | 0,78 | ano |
| Šest žánrů plánu (25 vět): finále | ≥ 0,8 | 0,04 | **0,88** | ano |
| Šest žánrů: chování, medián | ≥ 2 | 1 | 3 | ano |
| Šest žánrů: mrtvý čas, medián | ≤ 3 s | 5,35 s | 2,5 s | ano |
| Šest žánrů: stoupání | ≥ 0,7 | 0,28 | 0,88 | ano |
| Panel P45: věta s horším finále nebo mezerou delší o > 1 s než v A | 0 | – | 0 ze 40 | ano |
| Párový soud nad buňkami šesti žánrů, podíl B | ≥ 0,6 | – | viz Párový soud | – |

Všech 60 vět holdoutu dalo hratelnou hru v A i v B.

## Po žánrech (holdout)

| Žánr | Vět | Finále A | Finále B | Mrtvý čas A | Mrtvý čas B | Chování B |
|---|---|---|---|---|---|---|
| aréna se sbíráním | 12 | 1/12 | 9/12 | 4,96 s | 2,49 s | 3,5 |
| útěk / přežití | 6 | 0/6 | 6/6 | 11,89 s | 2,5 s | 4 |
| quest v prostoru | 2 | 0/2 | 2/2 | 20,59 s | 2,5 s | 4 |
| stanoviště | 2 | 0/2 | 2/2 | 1,74 s | 1,74 s | 0 |
| duel | 1 | 0/1 | 1/1 | 2,35 s | 2,35 s | 1 |
| hod | 2 | 0/2 | 2/2 | 2,25 s | 2,25 s | 1 |
| **šest žánrů celkem** | 25 | 1/25 | **22/25** | 5,35 s | 2,5 s | 3 |
| mimo rozsah: řízení, aréna boj, skákačka, rytmus, střílečka | 17 | 17/17 | 17/17 | 2,1–5,98 s | beze změny | – |
| mimo rozsah: běžec | 5 | 4/5 | 4/5 | 5,07 s | 5,07 s | 3 |
| mimo rozsah: chodec | 4 | 0/4 | 0/4 | 15,64 s | 15,64 s | 0 |
| mimo rozsah: klouzání | 5 | 0/5 | 0/5 | 2,15 s | 2,15 s | 0 |
| mimo rozsah: míč | 2 | 0/2 | 0/2 | 3,42 s | 3,42 s | 1 |
| mimo rozsah: `arena_catch` (volný pohyb) | 1 | 0/1 | 0/1 | 9,35 s | 9,35 s | 1 |
| mimo rozsah: načasování | 1 | 0/1 | 0/1 | 2,75 s | 2,75 s | 0 |

Žánry mimo rozsah mají v A i B po větách táž čísla (finále, mezera, chování) – P47A je nemění.

## Co splněné není a proč

- **Finále celého holdoutu 0,72 < 0,8 (43/60).** Z 17 vět bez finále je 14 mimo šest žánrů plánu: chodec 4, klouzání 5, míč 2, `arena_catch` 1 a načasování 1 průběh nemají vůbec (důvod `entry`), běžec h024 průběh má, ale telemetrie finále na semínku publikace neuznala (stejně v A). Holdout má v šesti žánrech jen 25/60 vět (zapečetěná sada P45 63/100), takže žánry mimo rozsah (35 vět, finále 21/35 = 0,6) celek stáhnou pod cíl; šest žánrů samo dává 0,88.
- **Zbylé 3 věty bez finále jsou aréna se sbíráním s díly P42** (h028 balónky s pavouky, h037 jablka do košíku, h047 číšník s talíři): průběh nedostanou (důvod `assembly`, rozhodnutí T1/T3). Bez nich má aréna se sbíráním finále 9/9. Díly P42 jsou na holdoutu 4/60 = 6,7 % vět (čtvrtá je aréna boj h004, která finále má), pořád pod hranicí 10 % z „Co nevíme“; v šesti žánrech ale 3/25 = 12 %.
- **Mrtvý čas celku 2,99 s je splněný jen těsně.** Táhnou ho žánry mimo rozsah: chodec 14–19 s, střílečka 5,98 s, běžec 5,07 s, rytmus 4,0 s. V šesti žánrech je medián 2,5 s a nad 3 s jsou jen tři věty s díly P42 (5,2–8,9 s, bez průběhu a tepu) a útěk h050 3,23 s (v A 16,67 s).
- Stanoviště má medián chování 0 (nepřátele nemá, cíl platí „tam, kde nepřátelé jsou“), duel a hod 1 – jeden soupeř, resp. terč-boss. Stoupání hodu je 0 (2 věty), stejně jako na dev sadě po T7.

## Panel P45 (40 vět)

| | Finále | Chování (medián) | Mrtvý čas (medián) | Stoupání |
|---|---|---|---|---|
| A | 0,38 | 1 | 4,0 s | 0,63 |
| B | 0,68 | 1,5 | 2,76 s | 0,83 |

Žádná věta nemá v B horší finále ani delší mezeru: finále získalo 12 vět, žádná ho neztratila, boss se nikde nezměnil na climax a nejdelší mezera se neprodloužila u žádné věty (největší rozdíl B − A je 0 s). Hratelné 40/40 v A i B. V šesti žánrech panelu má finále 13/15 vět (A 1/15).

## Vývojová sada (30 vět, na ní se ladilo)

| | Průběh | Finále | Chování (medián) | Mrtvý čas (medián) | Stoupání |
|---|---|---|---|---|---|
| A | 0,37 | 0 | 1 | 4,67 s | 0,33 |
| B | 0,9 | 0,87 | 2,5 | 2,45 s | 0,8 |

B po žánrech: aréna se sbíráním finále 0,7 (3 věty s díly P42 bez průběhu), útěk / přežití 1,0, quest v prostoru 0,8 (q01 prohrál na semínku publikace), stanoviště, duel a hod 1,0; mrtvý čas všech šesti žánrů 1,74–2,5 s. Kontrola měřidla: A dává na dev sadě i panelu tatáž souhrnná čísla (průběh, finále, chování, mrtvý čas, stoupání) jako `baseline.json` naměřený na `abe38f04` v T1, B tatáž jako `after.json` po T11.

**Odvozeno (ne změřeno):** šest žánrů na holdoutu (finále 0,88, mrtvý čas 2,5 s) vychází stejně jako dev sada (0,87, 2,45 s), takže ladění na dev sadě se na nových větách neztratilo.

## Párový soud

Výsledek doplní koordinátor z běhu párového soudu.

Zdrojová data: `evals/play/p47a/final.json` (cíle, souhrny A a B, řádky po větách holdoutu i panelu), měřidlo `evals/play/p47a/finale.measure.ts`; že čísla cílů jsou z holdoutu, hlídá `evals/play/p47a/__tests__/final.test.ts`.
