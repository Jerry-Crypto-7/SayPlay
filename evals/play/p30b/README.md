# P30B – zisk na offline řetězu věrnosti

Naměřeno 2026-09-27 na `6bc1d390` (T7). Data: `after.json`, hlídá je `scripts/__tests__/p30b-gain.test.ts`.

**Výsledek:** hrdina kreslený ve 39 případech místo 35, položky v 67 místo 57, prostředí v 58 místo 55. Slovesa beze změny (61). Žádná položka, kterou baseline kreslila, se neztratila.

## Co se měří

- **Věty:** korpus 30 (`evals/play/fidelity/corpus.json`) a zamčená `judge-10`.
- **Dva zdroje specu:** slovní draft (první snímek hry) a zmrazené AI specy posledního živého běhu (`live.json`). Model se nevolá, takže rozdíl jde připsat jen opravám vykreslení a knihovny.
- **`drawn`** = offline řetěz (`src/play/fidelity/chain.ts`) najde pro položku z věty tělo a model. Je to odhad z kódu, ne to, co pozná člověk na snímku – to změří až živé měření za HALT.
- **Před (`before`)** = kód T1 (`f267f142`) s dnešním pravidlem slovesa navrch (T2 `bd26481b`, `93c1dca5`, R2 `2d137b7f`, R1 `6bc1d390`). Od R2 se sloveso počítá jen tehdy, když robot po výstřelu pravidla naměří změnu hry; obě strany proto měří stejným metrem. Hrdina, položky i prostředí vyšly na baseline přesně jako v mapě ztrát T1 (`losses.json`), slovesa taky – přísnější pravidlo na baseline žádné sloveso neubralo.
- **Po (`after`)** = HEAD.

## Čísla

Kreslené / všech, před → po.

| sada | zdroj | hrdina | položky | prostředí | slovesa |
|---|---|---|---|---|---|
| korpus | draft | 13 → 14 / 18 | 19 → 22 / 38 | 22 → 23 / 24 | 25 → 25 / 30 |
| korpus | ai | 13 → 15 / 18 | 24 → 31 / 38 | 23 → 24 / 24 | 27 → 27 / 30 |
| judge-10 | draft | 5 → 5 / 5 | 7 → 7 / 13 | 3 → 4 / 9 | 4 → 4 / 10 |
| judge-10 | ai | 4 → 5 / 5 | 7 → 7 / 13 | 7 → 7 / 9 | 5 → 5 / 10 |
| **celkem** | | **35 → 39** (+4) | **57 → 67** (+10) | **55 → 58** (+3) | **61 → 61** |

Cíle plánu: hrdina +4 (T3) a položky +10 (T4) – oba splněné přesně na hraně.

## Co přibylo (17 položek)

| role | věta | zdroj | položka | oprava |
|---|---|---|---|---|
| hrdina | s056 | draft, ai | scooter | T3 – závod jezdí katalogová vozidla |
| hrdina | h07 | ai | elephant | T3 – mřížka bere výběr arkády, když tag chybí |
| hrdina | j07 | ai | squirrel | T3 – totéž |
| položka | s006 | draft, ai | sprinkler | T4 – vlastní model kropítka |
| položka | h05 | draft, ai | kangaroo | T4 – vlastní model klokana-boxera |
| položka | s056 | draft, ai | traffic | T4 – závod kreslí popisek mantinelu |
| položka | s056 | ai | pizza | T3/T4 – slovo je v popisku hrdiny „pizza delivery scooter“, kterého závod teď kreslí (odvozeno, commit nerozlišen) |
| položka | s058 | ai | crocodile | T4 – závod kreslí popisek mantinelu |
| položka | s144 | ai | lily pad | T4 – rytmus kreslí noty |
| položka | s099 | ai | pancake | T4 – načasování kreslí díl věže |
| prostředí | s022 | draft, ai | tower | T6 – věž dostane sadu hradu |
| prostředí | j08 | draft | tower | T6 – totéž |

## Co zůstává ztracené a proč to P30B neřeší

Po HEAD zbývá 69 nekreslených položek: 58 není ve specu vůbec (`not-in-spec`), 11 ovládání nečte (`not-read-by-control`).

- **Slovesa (19, všechna `not-in-spec`):** „do taxes“, „date“, „pitch“ – ovládání a pravidla vybírá režisér (P30A), P30B režiséra nemění.
- **Položky mimo spec (32)** („investor“, „acorn“, „quantum physics“): roli do specu píše režisér nebo slovník draftu; vykreslení nemá co kreslit.
- **Hrdina, kterého ovládání nečte (6):** souboj, volný pohyb a rytmus popisek hrdiny nečtou (např. grandma, black hole, frog) – mapa ztrát T1 je nezařadila do T3.
- **Projektil hodu** („snowball“, „knife“): hod čte popisek jen hráče a terče – chce novou schopnost, ne opravu vykreslení.
- **Prostředí mřížky** na snímku: řetěz ho počítá jako kreslené už na baseline, oprava T6 (zem podle místa) se v `drawn` neukáže. Jestli ji porota pozná, řekne živé měření.

## Jak to přeměřit

```
git worktree add --detach .claude/p30b-base f267f142
git -C .claude/p30b-base cherry-pick -n bd26481b 93c1dca5 2d137b7f 6bc1d390
cp scripts/p30b-losses.mjs .claude/p30b-base/scripts/
node --experimental-strip-types .claude/p30b-base/scripts/p30b-losses.mjs --rows <before.json>
node --experimental-strip-types scripts/p30b-losses.mjs --gain <before.json>
git worktree remove --force .claude/p30b-base
```

Baseline běží ve vlastním procesu: zavaděč `scripts/ts-paths.mjs` vede `@/` do `src/` té kopie, která se načetla první, a ve společném procesu by baseline četla katalog z HEAD (naměřeno: kropítko a klokan by se tvářily jako kreslené už před T4).
