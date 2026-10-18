# P52 – akce z věty: co hráč napíše, to hrdina umí a použije

Plán `plans/P52-akce-z-vety-2-2026-10-17.md` (necommitovaný). Větev `features/P52-akce-z-vety-2-2026-10-17`; T1 ji posunula fast-forwardem na lokální větev P51 (`e3b2fd4a`, obsahuje `origin/main` `9aa10350`) – P51 na origin není.

## Sady

- **`dev.json`** – 40 vět napsaných 18. 10. na mezery, které nechal P47B (Fakta plánu): 17 mezer po dvou větách (`gap`) a 6 pastí, kde sloveso akce patří nepříteli (`enemy-verb`, `wants: []`). `wants` = ruční štítek akcí hrdiny v pořadí věty. Žánr, kam věta na semínku 1 padne, test nedrží (T8 ho u duelu záměrně mění); zapisuje ho `baseline.json`. Na dev sadě, na `p47b/verb-dev.json` a na větách P46A se ladí a diagnostikuje.
- **`holdout.json`** – 40 vět, které napsal nezávislý subagent bez přístupu ke kódu, plánům a sadám. Dostal jen pět akcí hrdiny s příklady sloves, tvar záznamu, pokyn psát přirozené věty hráčů 13+ a rozložení: 30 vět s akcí hrdiny (po 6 na akci, asi 8 se dvěma akcemi), 10 vět se slovesem jen u nepřítele (`family: "enemy"`). Věty zapsal sám a vrátil jen otisk – nikdo z P52 je nečetl. **SHA-256 nad LF bajty: `5dad1fbaac0da5066ff2a8906ce9fba5677770db33b868176b004bf32c8d3e61`** (hlídá `__tests__/sets.test.ts`). Do konečného měření T11 ho čte jen test otisku a tvaru (do výstupu jdou jen id).
- Žádná věta dev ani holdoutu se po `normalizeSentence` neshoduje s jinou sadou `evals/play/**` (soubory do 1 MB) ani mezi sebou.

## Měřidlo

Gauge P47B (`p47b/actions.ts`, popis v `p47b/README.md`), od P52 navíc s žánrem návrhu v řádku (`genre`, `genreOfSpec` z P47A):

```
P47B_SET=p52|dev|p46a P47B_OUT=<f> npx vitest run --config vitest.measure.mts evals/play/p47b/actions.measure.ts
```

`P47B_SET=p52` bez `P47B_OUT` píše `evals/play/p52/p52.json`. Holdout P52 jen v T11: `P47B_SET=p52-holdout P52_OPEN_HOLDOUT=1`. Finále P51 hlídá gauge P47A: `P47A_SET=p51 P47A_OUT=<out> npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts` (píše do `evals/play/p51/`).

## Výchozí stav (`baseline.json`, po T1)

Robot `intermediate`, semínko 1, kompilátor `genre.v5`. Podíly nad větami, které akci chtějí; past = podíl pastí, kde hrdina akci ze slovesa dostal.

| Sada | Vět | Chce akci | Má akci | Robot použije | Sloveso se projeví | Past | p95 návrhu |
|---|---|---|---|---|---|---|---|
| P52 dev | 40 | 34 | 0,12 | 0,24 | 0,24 | 0,5 (3/6) | 3,6 s |
| P47B dev (`verb-dev.json`) | 65 | 50 | 0,70 | 0,76 | 0,74 | 0 | 3,7 s |
| P46A | 20 | 19 | 1 | 1 | 0,89 | – | 3,2 s |
| Finále P51 (gauge P47A) | dev 30 / panel 40 | – | – | – | – | – | finále 0,97 / 0,93 |

- P47B dev klesl proti `p47b/after-dev.json` (0,74 / 0,84 / 0,82) – změřeno nad sloučenou P51; o kterou větu jde, ukáže srovnání řádků v T3.
- p95 návrhu je čas stroje a v době měření běžely souběžně jiné relace; P47B naměřil 1,7 s. Brána ≤ 2 s se posoudí v T11 na klidném stroji.
- Hratelné všechny hry ve všech třech sadách.

## T3 – slovník a past sloves nepřítele

Slovník akcí hrdiny je v `src/play/draft/controls.ts` (`ABILITY_CUES`, `heroDoes`), sloveso záměru v `src/play/intent/extract.ts`; T3 mění oba.

- **Nová slovesa** (minutá na dev sadě P52): „darts/veers + předložka“ → dash (d29, d30), „smacks“ (+ „thumps“, „pummels“) → strike (d02), zvednutý štít „raises a force field“, „holding up a shield“ → shield (d22, d28).
- **Past nepřítele** (`enemyDoes` v `extract.ts`): sloveso střelby nebo úderu ve vedlejší větě s jiným podmětem („as hunters shoot“, „as cannons blast“) nebo holý množný podmět, který střílí na hrdinu („enemy turrets fire at a little robot crossing…“, „guards shoot at you“, „hawks grab at a field mouse running…“). Záměr takové sloveso nepočítá jako akci hrdiny (jen `shoot`/`fight`/`kick`, „until the door unlocks“ zůstává) a doplněk střelby ho nečte.
- **Gauge po T3:** P52 dev 0,24 / 0,35 / 0,32, past **0** (dřív 0,5); P47B dev 0,70 / 0,76 / 0,74 a P46A 1 / 1 / 0,89 beze změny. Věty T3 (d02, d28, d29, d30 – bránil jim jen slovník) mají `hasAction` 4/4; d22 slyší štít, ale střílečka štít nebere (T7).
- **Zbývá:** d35 („enemy turrets fire at a little robot…“) staví střílečku – hrdina střílí, protože je to mechanika žánru, ne akce ze slovesa; gauge ji jako past nepočítá. d25 („…and the captain grabs the treasure map“) – kapitán není hrdina věty, nechává se na T8.
- Uložené hry: spec nese akce i doplňky, slovník čte jen nový návrh – replay brána, `golden.test.ts` a `p51-stored-v4.test.ts` zelené.

## Rozhodnutí

- T1: větev P51 na origin není (`git ls-remote` bez ní); sloučena lokální `features/P51-…`, která `origin/main` už obsahuje – fast-forward bez merge commitu.
