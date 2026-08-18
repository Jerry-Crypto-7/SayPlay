# Gold `EditContract` — kdo je napsal, čím jsou kryté a co dokázat nejdou

Napsáno P7a T702 (`plans/P7-brany-a-evaluace.md`), 18. 8. 2026.

Tenhle dokument je **doplněk k důkazu pořadím, ne náhrada za něj** — a začíná
tím, že důkaz pořadím tady vést nejde. Strojově to hlídá
`evals/contracts/__tests__/gold-frozen.test.ts`; věty níž jsou v tvaru, který
ten test čte, takže nemůžou zestárnout tiše.

```
orderingProof: unavailable
signedCommit: false
liveRunsPredateContracts: true
```

## Co AC žádalo a proč se to nesplnilo

AC T702 chce „kontrakty leží v podepsaném commitu předcházejícím prvnímu
evidovanému běhu modelu". Obě půlky jsou nesplnitelné a je to naměřené, ne
odhadnuté:

1. **Podepsaný commit.** V repozitáři není podpisový klíč nastavený a **žádný
   commit není podepsaný** (`git log --format=%G?` vrací `N` na všech). Klíč je
   lidská závislost, která patří do P0 spolu s účtem — kód na ni nečeká a čekat
   nemůže.
2. **Předchůdnost před během modelu.** `evals/live/` nese běhy z **14. 8. 2026**
   (kill gate, 27 případů). Tyhle kontrakty vznikly **18. 8. 2026**, tedy o čtyři
   dny později. **Běh, který se už odehrál, nejde předběhnout** a žádná pozdější
   práce to nespraví. Přepsat historii by znamenalo udělat přesně to, co doktrína
   zmrazení zakazuje.

Provenience se tedy **netvrdí**. Plán s tím ostatně počítá vlastními slovy:
*„provenance se u jednočlenného týmu dokázat nedá. Obrana proto necílí na to, kdo
kontrakt napsal, ale na tvar."*

## Čím jsou kontrakty kryté místo toho

Nosná je **rovnost proti druhému, nezávislému zdroji**, ne autorství:

- **Oprávnění** (`allowedWrites`, `allowedCreates`, `allowedDeletes`) se rovnají
  tomu, co referenční aplikace zmrazeného patche na zmrazený základní svět
  **doopravdy** udělá — počítáno rozvinutím diffu stavu před a po
  (`src/patch/scope.ts`, týž výpočet, jaký běží na produkční cestě).
- **Druhý zdroj** je `allowedPaths` ze zmrazeného popisu
  (`evals/frozen/contracts.v1.jsonl`). Kde se zdroje rozejdou, kontrakt to
  **vypisuje do posledního listu** v poli `escapingLeaves` a test to porovnává.
  Tohle je jediná kontrola v souboru, která **není opisem** — a jde červeně,
  jakmile se kterýkoli ze dvou zdrojů pohne.
- **Granularita** je vynucená schématem: zápis je listový pointer, vznik je
  trojice `(kind, parentId, semanticRole)` označující právě jeden uzel, smazání
  je jednotlivá cesta a **žádná položka nesmí být předkem jiné**. Praní kontraktu
  je vždycky rozšíření, a rozšíření tímhle neprojde.

## Jak vznikly, poctivě

**Seznamy pointerů jsou strojový přepis, ne ruční sazba**, a tvrdit opak by bylo
zvlášť trapné v dokumentu o provenienci. `E18` má 39 vzniklých listů přes jedenáct
uzlů; jejich vypsání rukou nepřidává nic než překlepy.

Ručně rozhodnuté je to, co stroj rozhodnout nemůže, a je toho víc než seznamů:

- **kde je hranice vzniku** — nejvyšší uzel, který v základním světě neexistuje,
  a proto se `add` sedmnácti listů vykáže jako jeden vzniklý uzel, ne sedmnáct,
- **tabulka `kind` podle kontejneru** — leží v testu, ne v kontraktech, aby si
  kontrakt nemohl přinést povolení sám k sobě,
- **podlahy po třídách**, včetně vlastních podlah pro `topology_rewire` a
  `goal_swap`,
- **výběr postpodmínek, chráněných pozorování a svědků** ze zmrazených požadavků,
- **anotace u dvanácti záznamů**, kde patch a kontrakt nesedí nebo kde patch
  vůbec neprojde.

## Naměřené vady korpusu, které kontrakty vykazují

Korpus se **nemění** (AC T2b to zakazuje). Kontrakty ho popisují takový, jaký je:

- **Čtyři patche se neaplikují** — `E06`, `E19`, `E20`, `E24`. Nesou
  `derivable: false` a doslovné znění chyby, na které padnou. Bezchybná emise to
  nespraví; vada je v korpusu.
- **Osm záznamů sahá mimo vlastní `allowedPaths`** — `E01`, `E04`, `E13`, `E14`,
  `E15`, `E16`, `E22`, `E23`, z toho sedm s deklarovaným verdiktem `FULFILLED`.
  Naměřeno nezávisle tímhle testem a shodné s tím, co si projekt zapsal dřív
  (`CLAUDE.md`, rozpor 4b). Část je nutná kolaterála (`E01` srovnává `init`
  s `durationTicks`), část ne (`E14` maže `rules/pop`, kontrakt jmenuje
  `rules/roundEnd`).
- **`/sim/layout/portals` je pořád POLE.** Vznikají v něm uzly na indexech, takže
  jejich `semanticRole` je pozice, ne stabilní id — a vložení nebo smazání
  portálu posune všechny za ním. Je to **tentýž tvar vady**, který přemrazení na
  v2 opravilo u `sim.rules` a u portálů neopravilo. Týká se `E17` a `E18`.

## Podlahy odvoditelnosti po třídách

Naměřené, ne zvolené. Agregát by `topology_rewire` a `goal_swap` schoval za
ostatní, proto mají vlastní.

| Třída | V korpusu | Odvoditelných | Podlaha |
|---|---:|---:|---:|
| `param_change` | 3 | 3 | 3 |
| `predicate_flip` | 3 | 2 | 2 |
| `action_swap` | 3 | 3 | 3 |
| `rule_insert` | 3 | 3 | 3 |
| `rule_delete` | 3 | 3 | 3 |
| `topology_rewire` | 5 | 3 | 3 |
| `goal_swap` | 5 | 4 | 4 |
