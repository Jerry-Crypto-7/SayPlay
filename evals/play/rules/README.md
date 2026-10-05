# Pokrytí sloves pravidly – 200 vět poptávky (P29A T10)

Offline, bez modelu, 26. 9. 2026. Měří `coverage.ts`, artefakt `coverage.json`
(`npx tsx evals/play/rules/coverage.ts --write`), hlídá `coverage.test.ts`.

**Jak se třídí věta:**

- **dílek** – ovládání pro třídu slovesa věty (ruční štítek z `demand/corpus.json`)
  existuje a návrh ze slov (`draftGameSpec`, semínko 1) ho opravdu zvolí;
- **šablona** – dílek ne, ale věta obsahuje sloveso hotové šablony pravidla
  (`src/play/arcade/rules/templates.ts`: carry, throw, push, open, give, stack);
- **nic** – ani jedno.

## Před a po

| | dílek | šablona | nic | pokryto |
|---|---:|---:|---:|---:|
| před (jen dílky) | 145 | – | 55 | 145 / 200 = 72,5 % |
| po (dílky + šablony) | 145 | 5 | 50 | 150 / 200 = 75,0 % |

Šablony po větách: open 3, throw 1, stack 1.

## Deset nejčastějších nepokrytých sloves

Slovo ze slovníku herních sloves ve větě; věta bez něj nese štítek třídy v závorce.

| sloveso | vět |
|---|---:|
| (manipulate) | 6 |
| (build_place) | 3 |
| (throw) | 3 |
| build | 3 |
| match | 3 |
| merge | 3 |
| (idle) | 2 |
| (move_free) | 2 |
| (tap_go) | 2 |
| defend | 2 |

## Co z toho plyne (inference, ne měření)

- Šablony samy pokrytí skoro nezvednou (+5 vět, +2,5 p. b.): slovesa, na která
  sedí (nést, hodit, strčit, dát), korpus poptávky skoro nemá – ten je psaný
  podle hypercasual žebříčků, kde vládnou žánrová ovládání.
- Nepokrytý zbytek je hlavně žánr bez ovládání (manipulace, stavění, idle,
  spojování a slučování), ne chybějící sloveso. Na ten pravidla jako doplněk
  dílku nestačí; potřeboval by vlastní ovládání.
- „(throw)“, „(move_free)“ a „(tap_go)“ jsou věty, jejichž ovládání existuje,
  ale návrh ze slov zvolil jiné – to je směrování návrhu (P29B), ne chybějící
  dílek.
- Skutečný přínos pravidel se ukáže až na větách porotce, které slovesa
  jmenují („nes klíč ke dveřím“); ten měří živé kolo za bránou plánu.
