# P47C – modely přes noc se soudcem Opus 5.5

**Cíl:** za jednu noc (15.–16. 10. 2026) vygenerovat, slepě posoudit a povýšit modely s největším dopadem na hru: věci ke sbírání a cíle pro arena-collect a quest, předměty finále pro arena-collect, quest, duel a throw, znovu 24 modelů, které P46J vyřadila jako napůl poznané, a scenérii pro prostředí a základní sady vzhledu.

**Soudce:** Opus 5.5 (`--judge claude`) v předkontrole obrázku i ve slepém soudu listu – `claude -p --model claude-opus-5-5` v prázdném `mkdtemp`, jen `sheet.png`, jediný nástroj `Read`. Strop ~2000 volání. Došlý limit předplatného = smyčka čeká a zkouší soud každých 10 minut, nová dávka se nespouští.

**Přísnější shoda:** `matches()` v `scripts/p37d/judge-sheet.mjs` od P47C uzná stejné poslední slovo jen tehdy, když ostatní slova odpovědi jsou ze jména nebo jen popisují vzhled (barva, materiál, velikost). „dog statue“ už není „jaguar statue“, „wooden bench“ dál je „snowy bench“.

## Seznam (`round-nouns.json`, 316 jmen v pořadí fronty)

| Skupina | Jmen | Co |
|---|---|---|
| `p46i-pickup`, `p46i-obstacle`, `p46i-scenery` | 13 + 19 + 17 | nezkoušená jména P46I |
| `p46i-retry` | 17 | jména P46I, která čekají na jediné opakování (nová semínka) |
| `goal` | 37 | cíle a předměty finále: stupně vítězů, trofeje, pás šampiona, ring, gong, terče a pyramidy plechovek, podstavce s koulí, studny, trůny a koruny podle sady |
| `collect` | 74 | věci ke sbírání podle sady vzhledu (17 sad, po jedné sadě dokola) |
| `p46j-redo` | 24 | modely vyřazené P46J, znovu s ostřejším znakem v `ops/gen3d/features.toml` (komentář říká, co v nich viděl Codex) |
| `remake` | 2 | rafflesia a desert shrub – nový znak, povýšený model nahradí stejné id |
| `sparse-setting` | 11 | rekvizity pro junkyard garage, tightrope, sunken city (pod 3 rekvizitami) |
| `scenery` | 102 | scenérie základních sad, kde je místo i v `setting-kits.json` |

Neprošlé jméno dostane jedno opakování s novými semínky (`a2,b2,a3`), takže noc zpracuje přes 400 jmen. Každé nové jméno má znak ve `features.toml`, žádné nemá slovo třídy manifestu (`scripts/assets/p32-manifest.mjs`) a žádné katalog nezná (kontrola i přes katalogy větví P46 a P47).

**Rekvizity prostředí:** `kit-nouns.json` (čte ho `scripts/p45h/build-setting-kits.mjs` po P45G a P46I): 2 páry s modely, které katalog už má (unicycle – tightrope, sunken bell – sunken city), 3 páry, které P46J vzala s modely (rain barrel, cypress tree, ticket machine) a 36 jmen scenérie pro prostředí se 3 a méně rekvizitami. Prostředí připíchnutá v `look.test.ts` nedostanou nic.

**Synonyma soudu:** `aliases.json` = P46I + synonyma P47C. Synonymum se stane štítkem katalogu, takže jednoslovná obecná slova („table“, „net“, „sign“) vynechaná.

## Pravidla běhu

Jako P46I (`D:/caches/p46i/loop.mjs`): kolo 10 jmen ≈ 15 min, generování dalšího kola běží během soudu předchozího, po povýšení se regenerují třídy pohybu a `setting-kits.json`, sady `src/assets`, `scripts/p37d`, `scripts/assets` a testy vzhledu a katalogu, license-gate v pre-commit hooku, jeden commit na kolo `feat(assets): promote P47C models, batch <n>`. Červená sada samotná → modely kola vyřazené. Záznam kol `gen-round.md`, záznamy `D:/caches/p47c/round<n>/`, mezipaměť `D:/claude/_gen3d-cache-p47c`.
