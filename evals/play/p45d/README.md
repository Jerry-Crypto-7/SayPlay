# P45D – živé 3D postavy

Hračkový pohyb pro všechny modely knihovny a doplnění chybějících modelů. Plán: P45D (interní), spec `docs/specs/2026-10-08-p45-hloubka-a-zabava.md` (interní).

## Základ – `baseline.json`

8. 10. 2026, build `0714a352` (`origin/main`, obsahuje P43 + P44E `ef0bcdea`), návrh bez režiséra, panel `evals/play/p43/panel.json`, běh `p45d-baseline` (30 volání Codexu):

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set <worktree>/evals/play/p43/panel.json --clip --draft-only --gpu --base http://127.0.0.1:3245 --run p45d-baseline
node --experimental-strip-types scripts/play-fidelity.mjs judge --clip --run p45d-baseline
P43_RUN=p45d-baseline P43_OUT=../p45d/baseline.json npx vitest run --config vitest.measure.mts evals/play/p43/visible.measure.ts
```

| | `baseline.json` |
|---|---|
| hrdina modelem | 19/23 (83 %) |
| hrdina poznaný | 9/23 (39 %) |

P43 `after-b.json` měl hrdinu modelem 20/23 nad buildem `a11e657c`; navíc dnes chybí f08 (unicorn) – příčina nezjištěná (P44C mezitím změnil výběr modelu ke slovu).

**Hrdinové panelu bez modelu (vstup pro T16):** f08 unicorn, f24 cyclops, m09 ninja cat, u08 mole.

**P45A v `origin/main`:** ne – `git log origin/main --grep "P45A"` je prázdný a `evals/play/p45/` neexistuje (8. 10. 2026). Měření nad vývojovým panelem P45A čeká na sloučení (T20).

## Je postava živá – `alive-baseline.json`

8. 10. 2026, týž build `0714a352` (žádný hračkový pohyb), panel `evals/play/p43/panel.json`, 23 vět s hrdinou, 23 volání Codexu:

```
node scripts/p45d/alive-clip.mjs --run p45d-alive-baseline --gpu --out evals/play/p45d/alive-baseline.json
```

| | `alive-baseline.json` |
|---|---|
| živá (`alive`) | 17/23 (74 %) |
| poznaná (`likeNoun`) | 9/23 (39 %) |
| okno začíná pohybem hrdiny | 21/23 (91 %) |

Ne: unicorn (soudce viděl auto), baby dragon, phoenix, broom, grandma a hedgehog (ti dva stáli).

**Zjištění – měřidlo je zatím shovívavé.** 74 % vychází už bez hračkového pohybu, nad cílem 70 %. Část je skutečná (riggované postavy hrají klipy chůze a útoku – mole a cyclops jsou riggovaný farmář), ale list zlaté rybky (d12) ukazuje skoro nehybné tělo, které jen pluje, a soudce ho přesto uznal jako „swimming“. Jestli otázka měří pohyb těla, rozhodne kalibrace `--toy off` v T15 (vypnuto musí vyjít aspoň o 25 bodů níž); když ne, opravuje se otázka nebo pás snímků, práh zůstává.

## Je postava živá po pohybu ve všech scénách – `alive-after-motion.json`

9. 10. 2026, build `d4c63332` (všechny scény s hračkovým pohybem, T7–T14), týž panel a týchž 23 vět jako `alive-baseline.json`, dva běhy nad stejným buildem (23 + 23 volání Codexu):

```
node scripts/p45d/alive-clip.mjs --run p45d-alive-after --gpu --out <on>.json
node scripts/p45d/alive-clip.mjs --run p45d-alive-after-off --toy off --gpu --out <off>.json
```

| | základ `0714a352` | zapnuto | `--toy off` |
|---|---|---|---|
| živá (`alive`) | 17/23 (74 %) | **17/23 (74 %)** | 12/23 (52 %) |
| poznaná (`likeNoun`) | 9/23 (39 %) | 10/23 (43 %) | 9/23 (39 %) |
| okno začíná pohybem hrdiny | 21/23 | 21/23 | 18/23 |

- **Cíl `alive` ≥ 70 %: číslem splněný (74 %), jako důkaz pohybu ne.** Kalibrace neprošla, viz další bod.
- **Kalibrace neprošla: rozdíl 21,7 bodu, potřeba aspoň 25.** Měřidlo tedy pohyb těla neměří dost spolehlivě. Práh zůstal; opravený výřez a výsledek jsou v další části (T24).
- **Proti základu bez hračkového pohybu žádný zisk:** 17/23 před i po. Mezi zapnuto a vypnuto se liší 9 vět: 7 vypnutím „umřelo“ (ogre, baby dragon, knight, witch, pirate, bear, bird), 2 naopak „ožily“ (phoenix, goldfish).
- **Odhad (neověřeno): vypnuto je pod základem (12 vs 17), protože `?toy=off` vypne i pohyb, který byl před P45D.** Ten pohyb teď kreslí hračková vrstva. U ogre, knight a pirate se s vypnutím hrdina v okně ani nepohnul.
- **Šum soudce je velký.** Phoenix a goldfish soudce uznal jen s vypnutým pohybem a nic jiného se mezi běhy nezměnilo. Opakovaný běh téhož buildu tu není, takže rozptyl změřený nemáme.

**Nesplněné věty se zapnutým pohybem, po třídě těla.** Třída je podle slova hrdiny (`bodyOfNoun`), ne podle modelu, který hra nakreslila; víceslovná jména a tvory, které slovník nezná, padají do `prop`.

| třída (podle slova) | živá zapnuto | vypnuto | nesplněné zapnuto |
|---|---|---|---|
| biped | 4/5 | 1/5 | f24 cyclops – riggovaný farmář s klipem, soudce viděl „cowboy“ stát |
| quadruped | 3/3 | 2/3 | – |
| flyer | 3/4 | 1/4 | f26 broom – předmět stojí, hra s ním nehýbe |
| swimmer | 0/1 | 1/1 | d12 goldfish – „turtle floating“, vlnění ocasu soudce nepoznal |
| prop | 7/10 | 7/10 | f17 phoenix (šum, vypnuto prošel), m17 grandma a d01 hedgehog – hrdina se 6 s nehnul, takže podle kitu stojí |

### Měřidlo s vystředěným výřezem (T24) – `alive-after-motion.json` → `centredMeter`

**Proč:** v listech T15 se s vypnutým pohybem tělo nehýbalo, jen klouzalo po dlaždici (víla, auto, medvěd). Soudce to četl jako „jde“ nebo „jede“. Měřidlo (`648316a8`) proto každý snímek vystředí na hrdinu (`stableCropsOf`), takže přesun scénou zmizí. Otázka soudci to i říká. Práh a cíl zůstaly.

Týž build `d4c63332`, týž panel, 23 + 23 volání:

| | zapnuto | `--toy off` |
|---|---|---|
| živá (`alive`) | **19/23 (83 %)** | 10/23 (43 %) |
| poznaná (`likeNoun`) | 7/23 (30 %) | 10/23 (43 %) |

- **Kalibrace prošla: rozdíl 39 bodů, potřeba 25.** Měřidlo teď pohyb těla měří. Čísla T15 výš patří prvnímu měřidlu a s tímhle se nesčítají.
- **Cíl `alive` ≥ 70 %: splněn, 83 %.**
- **Vypnutý pohyb, a přesto „živá“ (10 vět):** riggované postavy hrají klipy, které vypínač nevypne (archer, troll, necromancer, cyclops/farmer, mermaid). Ninja cat skáče v jádře. Zbytek je šum soudce: fairy, goldfish a pirate prošli i jako stojící.
- **Odhad (neověřeno):** se zapnutým pohybem vychází „poznaná“ hůř (7 vs 10). Kymácení a poskok nejspíš mění obrys, podle kterého soudce tvar pozná. Rozptyl soudce ale změřený nemáme.

**Nesplněné se zapnutým pohybem, po třídě těla (podle slova):**

| třída | živá zapnuto | vypnuto | nesplněné zapnuto |
|---|---|---|---|
| biped | 5/5 | 3/5 | – |
| quadruped | 3/3 | 1/3 | – |
| flyer | 2/4 | 1/4 | s035 bird – „moving without visible body articulation“: mávání křídel deformací soudce na listu nevidí; f26 broom – předmět klouže po cestě, hračka ho jako předmět nehoupe |
| swimmer | 1/1 | 1/1 | – |
| prop | 8/10 | 4/10 | m17 grandma a d01 hedgehog – hrdina se v 6 s hry nehnul, takže podle kitu stojí |

## Výběr jmen pro generátor – `gen-nouns.json`

`node scripts/p37d/missing-nouns.mjs --out evals/play/p45d/missing.json` nad dnešním katalogem: 118 chybějících (P43 jich mělo 136). `node scripts/p45d/pick-nouns.mjs` z nich vybere 48: 2 hrdinové panelu (cyclops, mole), 29 podle počtu vět, 17 záměn soudce P43; 13 je plochých nebo drobných. Vyřazené jevy, kulisy a šum jsou v `scripts/p45d/not-models.txt`.

Unicorn (f08) a ninja cat (m09) knihovna kreslí (`covered`), hrdina modelem přesto chybí – to je výběr modelu ke slovu (P44C, `models.ts`), ne práce generátoru.

Třídu těla dává `bodyOfNoun` (`scripts/p45d/motion-class.mjs`); tvory, které `heroClass` nezná (mole, hippo, cyclops, robber …), doplňuje tabulka slov tamtéž, jinak by dostali šablonu předmětu.

## Reduced motion a telefon – `e2e/p45d-toy-motion.spec.ts`, `e2e/p35-perf.spec.ts`

9. 10. 2026, profil Pixel 7 se 4× pomalejším CPU, robot hraje „rukou“ tik na snímek, sonda `__playFrame().heroToy` čte, co `applyToy` hrdinovi nastavil (předklon, úklon, měřítko, poskok, výpad, díly, deformace). Pevné hry:

| id | hra | rozehrání (tiky) | bez emulace: největší rozptyl | `reduce`: snímků se změnou |
|---|---|---|---|---|
| `runner-zombie` | fixture `runner`, hrdina „zombie“ | 100 | 1,995 (nohy) | 0 |
| `platform-fox` | fixture `platform`, hrdina „fox“ | 100 | 1,972 (nohy) | 0 |
| `arena-turtle` | věta P32 `cat`, hrdina „turtle“ | 100 | 1,968 (nohy) | 0 |
| `duel-monkey` | fixture `duel`, hrdina „monkey“ | 100 | 0,444 (přikrčení) | 2 |
| `rhythm-bee` | fixture `rhythm`, hrdina „bee“ | 210 | 0,379 (zmáčknutí) | 0 |
| `quest-elephant` | věta P32 `firefighter`, hrdina „elephant“ | 10 | 1,949 (nohy) | 0 |

- **Hrdinové jsou modely katalogu.** Pes, kočka, tučňák a robot jsou riggované postavy s klipem běhu (`rigged*.json`) a hračka jim chůzi záměrně nezdvojí (T13) – s nimi by test měřil klip, ne hračku.
- **Pod `reduce` test hlídá přechody, ne každou změnu.** Přikrčení v souboji je výška těla v jádře (stav hry, jako poloha): skočí v jednom snímku a drží. Kit pod `reduce` okamžitou pózu stavu dovoluje; přechod nebo smyčka by pózu měnily snímek za snímkem. Práh: nejvýš 2 snímky se změnou z 30.
- **Výkon:** střelnice s 20 nepřáteli „kangaroo“ (model s díly ocas a noha; pes díly má taky, ale slovo „dog“ dostane riggovaného psa): najednou se kreslí 15 těl, díly přidají 2 sítě na tělo a ke každé obal obrysu – **4 sítě na tělo, ne 2**. Celá scéna 148 sítí, pod stropem kočičí arény 200. Kočičí aréna 109 sítí.
- **Běžec nepřátele nemá** (jen překážky, které se nehýbou), 20 nepřátel proto drží střelnice.

## Třídy těl – `src/assets/catalog-motion.json`

`node scripts/p45d/motion-class.mjs` nad 929 modely: prop 412, biped 346, quadruped 56, vehicle 50, flyer 34, swimmer 31; pohyblivý díl s rolí má 14 modelů. Třídu dává nejdřív manifest hrdinů P32, pak `heroClass` nad jednoslovným id, pak poměr rozměrů; model s dveřmi je vždy prop.
