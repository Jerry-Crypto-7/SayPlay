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

## Co příště měřit jinak

- Artefakt nenese **důvod** `MALFORMED` (`readDirectorAnswer.reason` + `detail`); příští měření ho
  má zapsat, jinak nejde říct, jestli model useknul JSON, nebo vymyslel mechaniku, kterou tabulka
  nezná.
- Do 12 s se dostane jen `WORLDSMITH_MODEL_EFFORT=low` nebo rychlejší model – měřit s tím, ne s
  dalším laděním promptu.
