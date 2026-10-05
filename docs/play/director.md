# Režisér (P23-B) – věta → GameSpec, hráč hraje hned

Vrstva `src/play/director/` + `src/play/draft/`. Vstup je jedna věta hráče, výstup validní
`GameSpecV1` – **okamžitě** z deterministického návrhu ze slov a **podruhé** po odpovědi modelu
(nebo po jeho výpadku, pak zůstane návrh). Model píše jen GameSpec (1–3,5 kB), nikdy kód ani
WorldDoc; kompilaci do světa dělá P23-A, obálku a remix UI P23-C.

## Jak to jde za sebou (`direct()`)

1. `draftGameSpec(sentence)` – lexikon → archetyp → role, počty, sekundy → šablona z fixtur. Nikdy
   `null`. Jde ven synchronně přes `onDraft` ještě před prvním `await`.
2. Cache (`directorCache`, klíč = věta po normalizaci + verze promptu + model + větev) → `cached`.
3. Model dostane pravidla balíčku, registr mechanik a archetypů vyrenderovaný ze zdroje a návrh
   jako výchozí bod (`buildDirectorRequest`). Odpověď čte `readDirectorAnswer`.
4. Kritik (`critique`) – blokující kódy `NO_AGENCY`, `NO_TERMINATION`, `CONTRADICTION`,
   `TOO_COMPLEX`, `UNFAIR_SPAWN`; ostatní jen varují a jdou ven ve `warnings`.
5. Oprava: nejdřív tabulka (`repairDeterministically`), pak nejvýš `maxRepairRounds` (výchozí 2)
   modelových kol RFC 6902.
6. Přijatý spec → cache → `authored`. Cokoli jiného → `draft` s `fallbackReason`
   (`MODEL_UNAVAILABLE` | `MALFORMED` | `UNREPAIRED`). Nikdy výjimka.

**Od P32B (T4, T5)** model píše `GenreSpec` (`readGenreAnswer`) a hru skládá modul žánru. Mezi
krok 3 a 4 přibyla kontrola věrnosti (`fidelity`: hrdina a nepřítel z věty, hlavní sloveso hraje
žánr a režim, režim `ready`); neprošlá odpověď přepne žánr po pořadí klasifikátoru
(`switchGenre`) s rolemi z odpovědi. Co neprojde ničím, ani opravnými koly, dohraje žánr draftu
jako `authored` bez `fallbackReason` (obálka: `UNCHANGED`) – `UNREPAIRED` režisér nevrací.

Remix: čtyři čipy (`Make it harder`, `Add a twist`, `Swap the enemy`, `Change the world, keep the
rules`) jsou RFC 6902 záplaty bez modelu (`remixPatch`); volná věta se zařadí (`classifyRemix`) a
jde přes model (`buildRemixRequest`).

## Naměřeno – 20. 9. 2026, jeden běh

Osm bucketových vět balíčku (jedna na archetyp), `gpt-6-astra` přes `codex-cli`, úsilí `medium`,
jedno opravné kolo, strop 12 volání. Artefakt: `evals/play/director-live.json`, drží ho
`evals/play/__tests__/director-report.test.ts`.

| Metrika | Hodnota | Cíl balíčku |
|---|---|---|
| Volání modelu | 8 (z 12) | – |
| `authored` | 7 / 8 | – |
| `archetypeHit` | 8 / 8 (i ta s návrhem) | – |
| Opravná kola | 0 u všech osmi | – |
| Medián | 40,4 s | p50 < 12 s |
| p90 | 55,0 s | – |
| Bajty specu | 1,3–3,4 kB | ~1–2 kB |

Jedna věta (`chase_escape-1`) skončila `draft` + `MALFORMED`: odpověď nešla přečíst ani opravit
z tabulky, a protože oprava RFC 6902 stojí nad přečteným specem, opravné kolo neproběhlo. Dvě
`authored` odpovědi nesou varování `BUDGET` (nad 80 % rozpočtu entit/pravidel).

**Co z toho plyne (inference):**

- Hráč hraje hned díky návrhu, ne díky modelu: 40 s medián je 3× nad cílem balíčku a rozdíl
  nezmenší prompt, ale jen rychlejší model nebo nižší úsilí. Návrh ze slov je proto nosná cesta,
  režisér s modelem je vylepšení, které dorazí později – P23-C/D s tím musí počítat v UI
  („hraješ návrh, model dopisuje").
- Astra podle prostého textového promptu píše GameSpec, ne WorldDoc – 7 z 8 přímo přijatých,
  0 kol oprav. Záporný příklad do promptu není potřeba.
- Návrh jako výchozí bod modelu neškodí: `archetypeHit` je 8/8 u `authored` i u `draft`, takže
  architektonická otázka z plánu („model opravuje návrh, nebo píše od nuly") zůstává rozhodnutá
  pro návrh v `user`.

## Čtečka a záloha (P29B, 26. 9. 2026)

Dva lokální modely přes llama.cpp na RTX 3090 (`ops/llm/`, instalace `install.ps1`, kontrola `check.mjs`):

| Role | Model | Port | Env | Stav |
|---|---|---|---|---|
| čtečka věty | Qwen3-4B-Instruct-2507 Q5_K_M | 8791 | `PLAY_READER=on`, `PLAY_READER_ENDPOINT`, `PLAY_READER_BUDGET_MS` (1500) | **vypnutá** ve výchozím stavu |
| záloha režiséra | gpt-oss-20b MXFP4 | 8792 | `WORLDSMITH_FALLBACK_ENDPOINT=llamacpp:http://127.0.0.1:8792`, `WORLDSMITH_FALLBACK_MODEL`, `WORLDSMITH_FALLBACK_TIMEOUT_MS`, `PLAY_DIRECTOR_HEDGE_MS` (30 000) | zapne ji vyplněný endpoint |

**Čtečka** přečte větu před draftem (route tvorby i `direct()`) a draft vezme ovládání, hrdinu, role,
místo a počty z čtení; klíčová slova doplní zbytek. Neodpoví-li do rozpočtu, draft je ze slov jako dřív.
Panel „From your sentence“ pak píše „read by a local AI model“ místo „from the keywords“.
**Pravidlo pro zapnutí:** judge-10 `read` ≥ klíčová slova + 0,10 a p95 ≤ 1 500 ms. Naměřeno 0,351
proti 0,514 a p95 1,5–2,1 s, proto vypnutá (`evals/play/read/README.md`).

**Záloha** se rozběhne, když předplatné do `PLAY_DIRECTOR_HEDGE_MS` neodpoví (nebo hned, když selže);
vyhrává první platná odpověď, zrušené volání se dopočítá do stropu. Odmítne-li primár strop nebo kvóta,
záloha se nezkouší. Autor hry je v `authoredBy`. Naměřeno na 30 + 10 větách: platných 38/40,
p50 4,5 s, judge-10 `read` 0,676 (`evals/play/local-director.json`); Qwen3.6-35B-A3B prohrál
(29/40, p50 31 s).

Spuštění (měření vždy pod zámkem GPU; za `-Then` jeden skript bez mezer):

```
powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role reader
powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback
node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role reader -Then evals/play/read/measure-all.cmd
```

Bez `-Then` server běží dál a skript vypíše PID (zastavit `Stop-Process -Id <PID>`).

## Co příště měřit jinak

- Artefakt nenese **důvod** `MALFORMED` (`readDirectorAnswer.reason` + `detail`); příští měření ho
  má zapsat, jinak nejde říct, jestli model useknul JSON, nebo vymyslel mechaniku, kterou tabulka
  nezná.
- Do 12 s se dostane jen `WORLDSMITH_MODEL_EFFORT=low` nebo rychlejší model – měřit s tím, ne s
  dalším laděním promptu.
