# P56A T11 – čtečka gpt-oss-20b na dev sadách

Čísla z `dev-result.json` (`npx vitest run --config vitest.measure.mts evals/play/p56a/dev.measure.ts`), čtení z `readings/*.gpt-oss-20b.json` (T4, llama.cpp MXFP4 na RTX 3090, `reasoning_effort: low`, prompt `beda31d4ee60c875`). Prompt se v T11 neměnil – důvod v posledním oddílu.

## Výsledek proti AC

| Co | Cíl AC | Naměřeno | Stav |
|---|---|---|---|
| Žánr p55 holdout-opened, cíle | ≥ 52/60 (majitel 21. 10. snížil na ≥ 40/60) | **41/60** | splněno snížené AC, původní ne |
| Pasti p55 | ≥ 19/20 (majitel: jen zapsat) | **16/20** | zapsáno |
| Hrdina P43 panel | – | **23/23** (bez čtení 22/23) | |
| Role P43 panel | – | **27/30** (bez čtení 22/30) | |
| Hrdina audit-12 s modelem podle slova | – | **12/12** (`identity`) | |
| Robot vyhraje / nečinný prohraje / replay | 100 % vět se čtením | **335/335** u všech tří | splněno |
| Latence lokální čtečky | zapsat | p50 **3,3 s**, p95 **7,9 s**, max 11,6 s (342 čtení) | |

## Žánr: srovnání politik (p55 holdout-opened, 60 cílů, 20 pastí)

| Politika | Cíle | Pasti zůstanou mimo nové žánry |
|---|---|---|
| Slovník sám (dnes bez čtečky) | 20/60 | – |
| Čtení samo („čtení rozhoduje“) | 35/60 | 18/20 |
| **Dnešní (T5 varianta a): slovník, když slyší nový žánr, jinak čtení** | **41/60** | **16/20** |
| Strop: aspoň jeden z obou trefí | 41/60 | – |

Dnešní politika sedí na stropu: každý cíl, který trefí čtení nebo slovník, hra dostane. Zbylých 19 chyb jsou věty, kde se mýlí **oba**, takže další body dá jen lepší čtení, ne jiné skládání. „Čtení rozhoduje“ by stálo 6 cílů a na p54c dev (T5) i 14 ze 64 (64 → 50).

**Proč každá chyba (oba zdroje špatně):**

- **Hop čtený jako běh nebo skákačka (6×: h33, h35, h37, h38, h39, h22 obrana jako běh).** „get across a six lane highway“, „step over train tracks one row at a time“ – model slyší pohyb, ne přecházení po řadách; slovník slyší „lane“ a „tracks“ jako běh nebo plavbu.
- **Krájení čtené jako souboj nebo načasování (3×: h29, h30, h32).** „ninja hacks them apart“, „cut every one before it drops“ – sloveso boje vyhraje nad znakem „letí vzduchem“.
- **Bouchání čtené jako Aréna, rytmus, střelba nebo načasování (4×: h12, h13, h15, h16).** „zap each one before it hides“, „tap tap tap“ – znak „vykukuje a schová se“ model nespojí s žánrem.
- **Vytlačování jako Aréna nebo nic (3×: h55, h57, h60).** „knock the rivals out over the edge“ – zápas čte jako rvačku.
- **Dav jako Aréna (2×: h43, h44).** „take the x3 portal, final showdown“ – závěrečný boj přebije bránu.
- **Chytání jako Aréna (1×: h05).** „stuff them in his sack“ – padání je ve vedlejší větě.

**Pasti, které hrají nový žánr (4):** h62 a h79 „hops“ (skákání, ne přecházení) → hop, h71 „merge two halves of a map“ → merge, h78 „take a whack at the boss“ → whack. Tři z nich dodá slovník (slyší slovo nového žánru), jednu čtení.

## Hrdina, protivník, svět, název (se čtením × bez)

| Sada | Liška bez slova „fox“ | Hrdina bez modelu (`fallback`) | Protivník bez modelu | Louka z nouze* | Šablonový název | Různé názvy |
|---|---|---|---|---|---|---|
| p55 holdout-opened (80) | 0 × 10 | 10 × 6 | 13 | 27 × 34 | 2 × 0 | 80/80 |
| p54c dev (80) | 0 × 10 | 1 × 0 | 5 | 32 × 39 | 1 × 0 | 80/80 |
| p54c holdout-opened (80) | 0 × 9 | 3 × 3 | 10 | 37 × 44 | 5 × 0 | 80/80 |
| p30 dev (60) | 0 × 3 | 3 × 2 | 4 | 11 × 13 | 2 × 0 | 60/60 |
| p43 panel (30) | 0 × 2 | 4 × 2 | 1 | 7 × 10 | 0 × 0 | 30/30 |
| audit-12 | 0 × 1 | 0 × 1 | 0 | 5 × 5 | 0 × 0 | 12/12 |

\* Louka, kterou věta ani čtení nejmenují (louka/park/farma a jejich druhy).

- **Liška zmizela:** se čtením 0 lišek, které věta neříká (bez čtení 35 na šesti sadách).
- **Hrdina bez modelu přibyl na p55 (6 → 10):** čtení dá podmět věty („elf“, „hamster“), na který knihovna modelů nemá tvar, kde slova daly lišku s modelem. Popisek je správně, obraz je náhradní tvar – patří k vykreslování (P56B), T12 to uvidí na snímcích.
- **Šablonový tvar názvu (10 na 412 vět) je název čtení, jen kde věta to slovo říká** („Street Race“, „Sword Duel“, „Hamster Escape“, „Starfighter Whack“ u pasti „take a whack at the boss“) – pin `title.test.ts`; bez čtení 0.
- **Louka z nouze klesla o 13–20 %, ne na cíl T7** (≤ jmenované + 5 p. b.): čtečka nechá `world` prázdný u 45–60 % vět (p55 45/76, p54c dev 46/79, holdout 49/80, p30 24/59).

## Co se v T11 nezměnilo a proč

- **Žánr:** dvě kola promptu na pojmenovanou třídu („nové žánry čtené jako obecná Aréna/běžec“) proběhla v T5 (`824fe29d`); pravidlo plánu třetí kolo stejného druhu zakazuje. 41/60 je strop dnešních dvou zdrojů; další body dá jen čtení na `medium` (T5: 27/44 × 22/44, lokálně p50 19,8 s) – tedy Groq (T14).
- **Svět povinný v promptu (kandidát z T7) – neuděláno.** Změna promptu přepíše čtení všech šesti sad (~40 min GPU) a ta jsou dnes vstupem pinů T5–T8 (hrdina 12/12, světy auditu, názvy, `readForChain`); každý by se musel znovu ověřit. Žádné další AC (T12, T13) svět neměří, takže by kolo nic nerozhodlo. Strop louky v `world.test.ts` zůstává.
