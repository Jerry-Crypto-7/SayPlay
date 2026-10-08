# P43 – co porotce vidí

P43 T16 nahrazen konečným měřením P44E; `sealed-100.json` zůstává zapečetěná jako rezerva.

Měření viditelnosti akce a poznatelnosti hrdiny a věcí. Plán: P43 (interní), spec `docs/specs/2026-10-07-p43-co-porotce-vidi.md` (interní).

## `sealed-100.json` – zapečetěná sada, 100 vět

Napsaná 7. 10. 2026 dřív, než se P43 dotkl kódu, autorem bez přístupu ke kódu P43, k `p30/test-200.json`, `p37`, `p41` a `p42` (jediný čtený soubor byl formát `p37a/dev-150.json`). Skupiny: `action` 35, `unknown-verb` 25, `fantasy` 22, `non-game` 18; pět vět s překlepem nese štítek `typo`.

SHA-256 (konce řádků LF): `6ae90a7051a55ff2664e75e376689ce7d3fd8bbdf54910384f9bf6f46caf8035`, hlídá ho `__tests__/sealed.test.ts`.

- Žádná věta se po převodu na malá písmena a bez interpunkce neshoduje s `p30/test-200.json`, `p30/dev.json`, `p37a/dev-150.json`, `fidelity/corpus.json`, `fidelity/judge-10.json`, `demand/corpus.json` ani `p41/sentences.json`.
- Na sadě se neladí a její věty nikdo z P43 nečte. Pečeť rozhoduje obsah (`source: "sealed-p43"`), ne cesta.

### Otevření (jednou, na konci P43)

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set p43-sealed --open-sealed-once --clip --draft-only --run <id>
```

Bez `--open-sealed-once` (nebo `--open-test-once`) běh odmítne. S ním se před první větou zapíše `sealed-opened.json` (čas, běh, commit, SHA-256) a každé další otevření odmítne.

## `panel.json` a `visible.measure.ts` – vývojový panel viditelnosti

30 vět vybraných jednou 7. 10. 2026 před první změnou vykreslení P43: 20 z `p37a/dev-150.json`, 10 z `p30/dev.json`; v každé sadě dvě třetiny se slovesem, které offline řetěz dokáže jako hrané (svědek), po žánrech, a třetina bez něj, po skupinách. Ladí se jen na něm. Měřidlo (`visible.ts`) čte jen panel; zapečetěnou sadu otevře až s `P43_OPEN_SEALED_ONCE=1` po běhu, který pečeť zlomil (hlídá `__tests__/visible.test.ts`).

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set <cesta>/evals/play/p43/panel.json --clip --draft-only --gpu --run <id>
node --experimental-strip-types scripts/play-fidelity.mjs judge --clip --run <id>     # 30 volání Codexu
P43_RUN=<id> P43_OUT=<soubor>.json npx vitest run --config vitest.measure.mts evals/play/p43/visible.measure.ts
```

| | `baseline.json` | `after-a.json` | `after-b.json` |
|---|---|---|---|
| sloveso poznané v klipu | 8/30 | 9/30 | 10/30 |
| sloveso poznané u vět se svědkem | 7/20 | 8/20 | 9/20 |
| hrdina modelem | 17/23 | 17/23 | 20/23 |
| hrdina poznaný | 7/23 | 6/23 | 12/23 |
| položka modelem | 13/38 | 13/38 | 13/38 |

Baseline 7. 10. 2026: klip z buildu `118f26da` (před změnami vykreslení P43), návrh bez režiséra, běh `p43-baseline`.

Po proudu A 7. 10. 2026: klip z buildu `47602c61` (podněty akce, střela a hod, sebrání a doručení, řádek se slovesem), běh `p43-after-a`. Výkon v profilu telefonu `e2e/p35-perf.spec.ts` nad týmž buildem 16/16 zelený, práh FPS beze změny.

**Práh nesplněn: sloveso u vět se svědkem 8/20 (40 %), cíl ≥ 50 %.** Proud A posunul o jednu větu, což je v šumu soudce. Čtení:

- Řádek se slovesem („Shoot the goblins!“) do čísla nevstupuje – klip skrývá všechno HTML a soudí jen scénu.
- Snímky klipu leží na pevných ticích (30, 90, 120); robot ukázky mezi tiky 51 a 126 nestřílí, takže snímky 1 a 2 akci často nezachytí. Posun snímků by změnil měřidlo T2, proto zůstává.
- „Hrdina poznaný“ 7 → 6 je jedna věta, v šumu; hrdinu ani modely proud A neměnil (to dělá proud B).

Po proudu B 7. 10. 2026: klip z buildu `a11e657c` (jména z Codexova soudu knihovny, souboj a rytmus kreslí hrdinu z věty, 17 nových modelů), běh `p43-after-b`.

| Práh | Výsledek | |
|---|---|---|
| hrdina modelem ≥ 85 % | 20/23 = 87 % | splněn |
| hrdina poznaný ≥ 65 % | 12/23 = 52 % | **nesplněn** |
| položka modelem ≥ 60 % | 13/38 = 34 % | **nesplněn** |

- Hrdina poznaný 6 → 12: posun dělá souboj a rytmus (rytíř, pirát, babička dřív kvádr nebo nic) a opravená jména knihovny.
- Hrdina bez modelu zůstal u tří vět: cyclops (f24, model neprošel generátorem), ninja cat (m09), mole (u08; generovaný model soudce viděl jako medvěda).
- Položka modelem se nepohnula: 20 z 38 věcí návrh do hry vůbec nedá (`not-in-spec`), a věci v questu (lucerny, lektvar) se modelem nekreslí, i když model existuje. Páka je v návrhu a ve scéně questu (soubory P42), ne v knihovně – výběr modelu ani nové modely tu číslo nezvednou.

## `missing.json` – podstatná jména bez modelu

`npx vitest run --config vitest.measure.mts evals/play/p43/missing.measure.ts` – sady demand, fidelity, judge-10, P30 dev, dev-150 a celá P41 (od P42 vývojová). Zapečetěné sady se nečtou.

7. 10. 2026 nad `ce5145d0`: 689 vět, **missing 136**, covered 853, undrawable 32, settings 85, unclassified 278. Chybějící jména jsou skoro všechna v jedné až čtyřech větách (nejčastější `fire` 4, `scarf` 3) – nízké „hrdina modelem“ a „položka modelem“ tedy dělá hlavně výběr modelu k větě, ne chybějící modely.
