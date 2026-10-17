# P46F – kalibrace soudce: Opus 5.5 proti Codexu

**Shoda na přijetí/odmítnutí: 15 z 20 (75 %)** – nad hranicí 70 % z plánu, noc běží s Opusem.

## Jak

- 20 listů čtyř pohledů z P45I (`D:/caches/p45i/round*/judge/sheets/`), u každého známý verdikt Codexu: 10 přijatých (`top1`/`top3`), 10 odmítnutých (6 `no`, 4 `broken`). Výběr rovnoměrně přes kola 1–24, jedno jméno jednou (skript `D:/caches/p46f/calibrate.mjs`, odpovědi `D:/caches/p46f/calibration/`).
- Opus 5.5 dostal stejnou otázku a stejné schéma jako Codex přes `scripts/p37d/judge-sheet.mjs` s `--judge claude`: `claude -p --model claude-opus-5-5 --safe-mode --tools Read` v prázdném `mkdtemp` jen se `sheet.png`. Verdikt podle stejné shody jména (`verdictOf`, aliasy `evals/play/p37d/aliases.json`).
- 20 volání, 20 odpovědí, žádná chyba; medián 15 s na list při třech souběžných otázkách.

## Listy

| Jméno | Kolo P45I | Codex | Opus 5.5 | Shoda | s |
|---|---|---|---|---|---|
| lake buoy | 7 | top1 („buoy“) | top1 („buoy“) | ano | 9.7 |
| mushroom house | 3 | top1 („mushroom house“) | top1 („mushroom house“) | ano | 10.1 |
| snowshoe | 1 | top1 („snowshoe“) | top1 („snowshoe“) | ano | 14 |
| snowy stump | 9 | top1 („tree stump“) | top1 („tree stump“) | ano | 17.8 |
| mop | 11 | top1 („mop“) | top1 („mop“) | ano | 18.2 |
| gas pump | 15 | top1 („gas pump“) | top1 („gas pump“) | ano | 22.8 |
| tool chest | 20 | top3 („tool cabinet“) | no („chest of drawers“) | **ne** | 23.5 |
| butterfly net | 17 | top3 („Fruit picker“) | no („torch“) | **ne** | 29 |
| fuse box | 22 | top1 („fuse box“) | no („cabinet“) | **ne** | 29.3 |
| champagne tower | 24 | top1 („Champagne tower“) | top1 („champagne tower“) | ano | 23.2 |
| stalagmite | 2 | no („traffic cone“) | no („traffic cone“) | ano | 21.7 |
| scoreboard | 7 | no („Railway signal“) | no („railroad crossing signal“) | ano | 14.2 |
| bandage | 11 | no („toilet paper“) | no („toilet paper roll“) | ano | 10.4 |
| receipt | 14 | no („Banner“) | no („scroll stand“) | ano | 9.3 |
| laundry basket | 17 | no („trash can“) | top1 („laundry basket“) | **ne** | 9.7 |
| diner sign | 22 | no („crystal sculpture“) | no („rose sculpture“) | ano | 11.9 |
| shipwreck | 1 | broken („shipwreck“) | top1 („shipwreck“) | **ne** | 12.9 |
| rock cairn | 9 | broken („Chess pawn“) | broken („rock cairn“) | ano | 14 |
| beer keg | 16 | broken („trash can“) | broken („vase“) | ano | 15 |
| duck decoy | 22 | broken („teapot“) | broken („flower pot“) | ano | 16.6 |

## Rozdíly

- **Opus přísnější u 3 přijatých:** tool chest a butterfly net prošly u Codexu jen alternativou (`top3`) – Opus je nazval prádelník a pochodeň a jméno mezi alternativami neměl. List butterfly netu (prohlédnutý) je bílý koš na tyči bez síťky, Opus tu má pravdu. Fuse box Opus nazval „cabinet“ s „electrical cabinet“ mezi alternativami – shoda jména ho shodí, přestože věc poznal.
- **Opus mírnější u 2 odmítnutých:** laundry basket (Codex „trash can“) a shipwreck. Vrak lodi je na listu (prohlédnutý) zubatý a roztřepený; Codex ho poznal, ale označil za potrhaný, Opus vzal roztřepení jako vzhled vraku.
- Úhrnem Opus přijal 9 z 20, Codex 10 z 20 – podíl povýšených v noci by měl zůstat blízko P45I (59 % soud).

## Odhad (inference)

- Opus se drží slov otázky („severe damage“) podobně jako Codex: tři ze čtyř `broken` potvrdil.
- Ztráta u fuse boxu je ztráta shody jména, ne soudu – stejná past jako „bug“ / „beetle“ v P37D. Když se v noci opakuje, řeší ji alias v `evals/play/p37d/aliases.json`, ne změna soudce.
