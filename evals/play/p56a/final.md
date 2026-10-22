# P56A T13 – zapečetěná sada otevřená jednou

Čtečka: **lokální gpt-oss-20b přes `llamacpp:`** (model dema, ne astra). Sada otevřena 22. 10. na `0dd2f0d2` (`holdout-opened.json`), od teď se počítá jen jako dev a nic se podle ní neladí. Čísla v `final.json`, snímky a odpovědi soudce v `visible-holdout.json`.

## Výsledek

| Brána | Cíl | Výsledek | |
|---|---|---|---|
| Cíle – žánr věty | ≥ 48/60 | **31/60** | nesplněno |
| Pasti – nehraje žánr, kam věta láká | ≥ 19/20 | **13/20** | nesplněno |
| Robot vyhraje | 80/80 | 80/80 | splněno |
| Nečinný hráč prohraje | 80/80 | 80/80 | splněno |
| Replay sedí | 80/80 | 80/80 | splněno |
| Hrdina i protivník z věty vidět (slepý soud ze snímků) | ≥ 0,8 | **0,16** (13/80) | nesplněno |
| Latence rychlé cesty bez čtečky | p50 ≤ A + 5 % | server 605 proti 579 ms (+4,5 %), párově po větách −17 ms | splněno |

## Proč žánr nesplnil

- **Oficiální průchod (`holdout.measure.ts`, rozpočet 60 s):** čtečka odpověděla jen u **39/80** vět. Model běžel s částí výpočtu na procesoru (GPU držel ComfyUI) a procesor byl na 100 % od cizích procesů – čtení trvalo kolem 60 s a polovina vypršela. U 41 cílů bez čtení hrál slovník (20/41 správně).
- **Kde čtení dorazilo (19 cílů):** čtení samo trefilo žánr 14×; dnešní politika (slovník přebije čtení, když slyší nový žánr – T5) z toho 4× přebila správné čtení špatným slovem (s02, s03, s09, s12). Hra pak měla správný žánr 11×.
- **Server se čtečkou, která stihla (informativně):** na běhu snímků (rozpočet 120 s, model celý na GPU, čtení 78/80) měla hra správný žánr u **39/60** cílů (režim 35/60). Ani s fungující čtečkou tedy brána 48/60 nepadá.
- **Pasti 13/20:** sedm vět zahrálo žánr, kam láká. V pěti z nich (s63, s73, s74, s77, s80) se nechala nalákat i čtečka, ve dvou (s64, s68) slovník.

## Proč věta není vidět

- Soudce viděl všechna slova věty u 13/80 her, jednotlivá slova 38/128; hrdinu 21/58, protivníka nebo věc 17/70. Na dev auditu (T12) to bylo 5/12.
- **63 ze 90 chybějících slov hra nese pod správným jménem**, soudce je ale nepoznal: postava je malá, kamera daleko, model vypadá jinak („too small and indistinct“, „no clear cat features“). To je vzhled, velikost a kamera – rozsah P56B.
- **27 slov do hry nedošlo vůbec** – žádná role je nenese (např. s03 yeti, s26 crocodile, s34 zombie, s65 dragon). To je díra P56A: čtečka nebo obsazení žánru protivníka či věc nepřenesly.
- Inference: i kdyby P56B udělala každou pojmenovanou postavu poznatelnou, strop je (38 + 63)/128 ≈ 0,79 slov; podíl her se všemi slovy by byl nižší.

## Odchylky od plánu

- **Prostředí:** RTX 3090 sdílel ComfyUI (cizí služba, nezastavená) – kolísal od 0,4 do 17 GB volné paměti a dvakrát vytížil GPU na 100 %. Oficiální čtení proto běželo s experty modelu na procesoru (`--n-cpu-moe 10`) a vypršelo u 41/80. Čísla oficiálního průchodu jsou zapsaná, jak vyšla.
- **Běh snímků:** rozpočet čtení 120 s (strop kódu) místo 60 s, model celý na GPU. Sedm her, jejichž čtení vypršelo, když ComfyUI držel GPU (s35, s36, s57–s59), nebo když prostředí po 3 h zastavilo llama-server (s79, s80), se zahodilo a udělalo znovu na čerstvém úložišti; dvě čtení vrátila prázdno za 13–18 s (s19, s61) a zůstala, jak jsou.
- **Strana A** (před P56A) se na zapečetěné sadě nesoudila – brána měří jen B a soud A by stál dalších 80 volání Codexu. Srovnání A × B je v T12 (2/12 × 5/12).
- **Latence** běžela prokládaně A,B,A,B na 30 dev větách jako T1 (`audit-12` + `p30/dev`), čtečka vypnutá, každý průchod na čerstvém `next start`. Stroj během měření zpomalil (A 463 → 579 ms, B 440 → 646 ms), proto rozhoduje sloučené p50 a párový rozdíl po větách; prohlížeč: sloučené p50 1 160 proti 1 034 ms, párově +5 ms.

## Doporučení

1. **Viditelnost řeší P56B, ne další čtení:** 63 z 90 chybějících slov je ve hře pod správným jménem. Měřit znovu až po P56B na dev sadách (audit-12, `visible.mjs`).
2. **27 slov mimo hru** je úkol pro další kolo P56A: protivník a věc věty se do role dostanou jen u části žánrů. Ladit na dev sadách, tahle sada už je dev.
3. **Politika žánru:** slovník přebil správné čtení 4× z 19. Ověřit na dev (p55 holdout, p54c), jestli „čtení přebije vždy, když odpoví“ nepoškodí pasti – rozhodnutí T5 stálo na dev číslech.
4. **Měřit čtečku na stroji bez ComfyUI, nebo přes Groq (T14):** půlka oficiálních čtení vypršela kvůli sdílenému GPU, ne kvůli modelu.
