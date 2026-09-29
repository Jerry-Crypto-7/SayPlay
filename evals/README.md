# Adversariální prompt suite

> **Současná měření produktu PLAY jsou v `evals/play/`** (věrnost `fidelity/`, poznatelnost `p30b/`, srovnání režisérů a zapečetěná sada 200 vět `p30/`). Tahle suite patří ke staršímu WORLDSTREAM.

**116 promptů. Napsané z pozice judge, ne autora.**

Pravidlo, které dává suite hodnotu: **autor ji nesmí ladit podle toho, co systém umí.** Když prompt neprojde, opravuje se produkt, ne prompt. Suite se smí rozšiřovat, nikdy zužovat.

## Rozdělení dev / holdout / reserve

Zmražená stovka, kterou autor průběžně vidí, je past: buď je nedotknutelná a k ničemu pro iteraci, nebo se na ni přes opakované agregátní výsledky nepřímo přeučí. Proto:

| Split | Počet | Režim |
|---|---:|---|
| `dev` | 60 | Vidím výsledky kdykoli, ladím podle nich |
| `holdout` | 40 | **Spouští se jen na kill-kritériových termínech.** Jednotlivé výsledky se neanalyzují, jen agregát |
| `reserve` | 16 | Nedotčené. Rotace, když se dev sada opotřebuje |
| _outsider_ | 20 | **Dodá někdo zvenčí těsně před freeze 4. 11.** Nikdy je předtím neuvidím |

Rozdělení je deterministické (seedovaný Fisher-Yates, seed `20260811`), takže se nedá znovu losovat, dokud nevyjde příznivěji.

**Model a konfigurace se pinují.** Bez toho měří CI kolísání dodavatele, ne kvalitu systému. U každého kill-kritéria se běh opakuje 3× a reportuje se rozptyl, ne jedno číslo.

## Rozložení

| Kbelík | Počet | Co testuje |
|---|---:|---|
| `in_category` | 25 | Plausibilní prompty uvnitř zvolené kategorie |
| `out_of_category` | 15 | T&C explicitně dovolují judgeům testovat mimo kategorii – datavis, architektura, výuka, medicína, průmysl |
| `mechanic_depth` | 15 | Vzniká **logika**, ne jen geometrie: čítače, podmínky, konjunkce, zdroje, paměť, zpětné vazby |
| `vague` | 10 | Podspecifikovaný vstup: "something cool", "?", jedno slovo |
| `contradictory` | 8 | Vnitřně rozporné zadání – musí se rozhodnout, ne spadnout |
| `nonsense` | 10 | Gibberish, emoji, prázdný vstup, XSS pokus, 5000 znaků |
| `non_english` | 8 | Čeština s diakritikou i bez, němčina, francouzština, japonština, arabština (RTL), míchané jazyky |
| `hostile` | 12 | Prompt injection, 10 000 kostek, nekonečná rekurze, 500 km scéna, IP infringement, konfliktní pravidla |
| `iterative` | 8 | Vícekolové zpřesňování včetně undo – testuje, jestli se svět **edituje**, nebo pokaždé generuje znovu |
| `perf` | 5 | Rozpočet snímku: instancing, LOD, culling, kompozice efektů |

## Formát

JSONL, jeden prompt na řádek:

```json
{"id":"IC01","bucket":"in_category","prompt":"...","pass":"co musí platit, aby to prošlo"}
```

`iterative` prompty oddělují kola znakem ` | `. Token `<<EXPAND:a*5000>>` rozbaluje harness.

## Brána

Podle `SCORING.md` §4: **žádná nová funkce, dokud odolnost neběží nad 90 % na aktuální suite.**

Harness měří na každém promptu: prošlo / neprošlo · čas k prvnímu vykreslení · čas k hratelnosti · vznikla logika nebo jen geometrie · screenshot. Jedno číslo za den, regresní graf.

## Co suite zatím netestuje

Chybí: přístupnost, chování na mobilu, výpadek dodavatele v půlce generování, a souběh více uživatelů. Doplnit, až bude co měřit.
