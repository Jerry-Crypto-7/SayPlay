# P41 – sada skládání (`sentences.json`)

Věty, na kterých P41 měří, jestli hra hraje **všechny** podstatné akce věty najednou (pohyb × akce × cíl × hrozby), nebo nahlas řekne, co chybí. Štítky jsou psané **ručně, 6. 10. 2026, dřív než poprvé běžel extraktor** (`src/play/intent/extract.ts`) – nikdo je z jeho výstupu neopisoval. Věty jsou nové, psané jako porotce; se zapečetěnou `../p30/test-200.json` se nepřekrývají (hlídá test strojem, zapečetěný soubor nikdo nečetl).

## Skupiny

| skupina | id | vět | co v ní je |
|---|---|---|---|
| `multi-action` | `ma-` | 53 | víc akcí naráz; věta majitele `game in a car with shooting and racing` a její varianty jízda + střelba, závod + střelba |
| `paraphrase` | `pa-` | 40 | 10 rodin po 4 větách (`family`), stejný záměr jinými slovy – stejný hrdina i trojice |
| `negation` | `ne-` | 27 | „without guns“, „no jumping“, „don't shoot“; dvě pasti s prázdným `negated` („never stop running“) |
| `unsupported` | `un-` | 22 | co hra neumí (šachy s drakem, pletení, báseň) – přiznané, ne natlačené do žánru |
| `single` | `si-` | 33 | jeden dnešní žánr; vč. závodu autem a `a dog chases a cat` / `a cat chases a dog` |
| `held-out` | `ho-` | 64 | všechny druhy (`kind`), vlastní rodiny parafrází |

**Held-out:** do závěrečného měření (P41 T32) se na ní **neladí** – nečte se při psaní extraktoru, skladatele ani režiséra a její čísla se do té doby nepočítají.

## Tvar štítku

```json
{ "id": "ma-001", "sentence": "…", "hero": "car", "setting": null,
  "essential": [{ "actor": "car", "verb": "drive", "object": null }],
  "unsupported": false, "negated": ["shoot"], "family": "…", "kind": "…" }
```

- `negated` jen u záporů, `family` jen u parafrází, `kind` jen v `held-out`.
- `verb` je kanonické id ze `src/play/intent/contract.ts` (`MOVES`, `ACTIONS`, `OBJECTIVES`, `THREATS`). Sloveso mimo slovník (`knit`, `play`) jen se `"unsupported": true` – a taková věta ho mít musí.
- **Hrdina** = koho hráč hraje, jednotné číslo; obvykle podmět („a dog chases a cat“ → `dog`, cíl `catch` → `cat`). Nejmenuje-li věta nikoho, `hero` je `null` a aktér `"hero"`. Vozidlo bez řidiče je hrdina samo („game in a car“ → `car`).
- **Prostředí** jedno slovo; synonyma sjednocená (sea/underwater → `ocean`, ice → `snow`, street → `city`), místo má přednost před denní dobou.
- Do `essential` jen to, co věta výslovně chce. Pohyb má `object: null`; akce má za předmět cíl, když ho věta říká, jinak věc („throw stars at guards“ → `guard`); hrozba má za aktéra hrozbu a za předmět hrdinu („a cat chases it“ → `{cat, chaser, mouse}`).
- Výklad sloves: `glide` = volný let a plavání, `flap` = mávání skrz mezery, `walk` = plížení a bludiště, `roam` = volný pohyb po otevřené aréně, `ball` = pohyb s míčem (fotbal, golf, kutálení), basketbalový „shot“ = `throw`, souboj jeden na jednoho a hádka = `duel`, bitka s víc nepřáteli = `fight`, záchrana a rozsvícení = `interact`.

## Kontrola

```
npx vitest run evals/play/p41/__tests__/set.test.ts
```

Hlídá tvar a slovník, počty skupin, jedinečná id i věty, zápory, shodu rodin parafrází, větu majitele a varianty a nulový průnik se zapečetěnou sadou (vypisuje jen id našich vět).

## Závěrečné měření T32

Spouští se až nad zmrazenou implementací, bez souběžného sestavení nebo testovací
zátěže. Výsledky held-out se nepoužívají k dalšímu ladění této revize.

```powershell
$env:P41_FINAL_OPEN_HELD_OUT = '1'
$env:P41_FINAL_LIVE_DIRECTOR = '0'
npx vitest run --config vitest.measure.mts evals/play/p41/final.measure.ts
```

Tato varianta změří baseline a rychlou verzi. Režisér a slepé hodnocení zůstanou
výslovně nezměřené. `final.json` uchovává všechny řádky, otisk zdrojů, revizi,
semínka a cíle; `final.md` uvádí každý neúspěch. Úspěšný běh měřicího skriptu
neznamená splnění číselných cílů.

Baseline používá vlastní vstup a `tsconfig` uvnitř checkoutu `p41-base`.
Guard odmítne přibalení aktuálních zdrojů; `baselineProvenance` v reportu
obsahuje jejich manifest a hashe. První pokus T32 tuto izolaci porušoval
kvůli automatickému výběru kořenového `tsconfig`; byl označen jako neplatný
a archivován v `.claude/scratchpads/p41-final-invalid-baseline`. Pro srovnání
se používá pouze následné měření s ověřeným původem baseline.

Po samostatném schválení odeslání konkrétních dat režisérovi lze nad stejnými
zdroji doplnit jen chybějící odpovědi pomocí `P41_FINAL_RESUME_DIRECTOR=1` a
`P41_FINAL_LIVE_DIRECTOR=1`. Vyžaduje platnou konfiguraci předplatného
`codex-cli` s explicitním limitem volání. Každá dávka eviduje vlastní limit
a spotřebu, report i kumulativní spotřebu. Denní rozpočet je nutné respektovat
napříč dávkami; tato volba jej nezvyšuje. Placený API fallback se nepoužívá.
Již pozorované neúspěchy se neopakují, baseline a rychlá verze se nepřepočítávají.
Pokračování vyžaduje dokončený report; není obnovou přerušeného zápisu.

`final-blind-pairs.json` obsahuje anonymní páry pro lidské hraní. Zachovejte
oddělený klíč `.claude/scratchpads/p41-final-blind-key.json`; neukazujte jej
hodnotiteli. Po dodání všech hodnocení lze bez generování her použít
`P41_FINAL_REVIEW_ONLY=1` a `P41_BLIND_RATINGS=<cesta k JSON>`; režim resume
musí být vypnutý. Formát hodnocení:

```json
{ "protocol": "human-blind-v1", "reviewer": "jméno",
  "ratings": [{ "pairId": "id z anonymního páru", "winner": "A" }] }
```

`winner` je `A`, `B` nebo `tie`; remízy zůstávají ve jmenovateli. Review-only
ověří stejné zdroje, dataset i původní A/B klíč. Commit pouze výsledků je
přípustný. Chybějící klíč se nesmí nahradit novým náhodným pořadím.
Samostatná přejímka majitelem je v `acceptance.md` a zůstává lidským krokem.
