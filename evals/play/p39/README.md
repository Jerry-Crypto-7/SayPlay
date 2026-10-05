# P39 – věci z věty ve správné roli: měření

`baseline.json` = stav před přestavbou obsazení (kód `c9ce1daa`, žánry a režisér jako na `main` `88245889`),
`after.json` = stav po přestavbě (kód `911f6f25`), stejný postup i formát.

## Co čísla znamenají

- `read`, `drawn` – podíl položek kontrolního seznamu dev sady (`evals/play/p30/dev.json`, 60 vět), které hra čte a scéna nakreslí.
- `role` – podíl položek, které navíc hrají roli, kterou jim věta dává (`does` v dev sadě; stupeň `role` v `src/play/fidelity/chain.ts`).
- `roleNamed` – totéž jen nad věcmi s očekávanou rolí (78 položek); tam se role může minout.
- `offline` – rychlá verze bez sítě; `live.draft` – rychlá verze ze serveru; `live.final` – AI verze, když vyšla, jinak rychlá.
- `byGenre` – průměr podílů přes věty žánru (žánr podle `controlParams.generator`, jinak ovládání).

## Výchozí stav (5. 10. 2026)

| | read | drawn | role | roleNamed |
|---|---|---|---|---|
| offline (rychlá) | 0,759 | 0,727 | 0,691 | 0,453 |
| živě, výsledná verze (AI 56/60) | 0,782 | 0,741 | 0,709 | 0,387 |

AI verze dnes roli věcí z věty spíš kazí (`roleNamed` 0,453 → 0,387).

## Po přestavbě (5. 10. 2026)

| | read | drawn | role | roleNamed |
|---|---|---|---|---|
| offline (rychlá), před | 0,759 | 0,727 | 0,691 | 0,453 |
| offline (rychlá), po | **0,773** | **0,741** | **0,709** | **0,493** |
| živě, výsledná verze, před (AI 56/60) | 0,782 | 0,741 | 0,709 | 0,387 |
| živě, výsledná verze, po (AI 55/60) | **0,791** | **0,750** | **0,727** | **0,440** |

- **Rychlá verze (offline i ze serveru):** `role` roste a `read` ani `drawn` neklesly v žádném žánru. Rostou plošinovka (`read` 0,667 → 0,833), plavba (0,8 → 0,85) a běžec (`role` 0,933 → 1); ostatní žánry stojí.
- **AI verze** roli věcí z věty pořád trochu kazí proti rychlé verzi (`roleNamed` 0,493 → 0,440), ale míň než před přestavbou (0,453 → 0,387).

### Živý běh po žánrech: jeden běh nestačí

`byGenre` výsledné verze v `after.json` řadí věty podle žánru, který zvolila AI. Ten se mezi běhy mění (duel 1 → 2 věty, timing 5 → 3), takže tabulka po žánrech srovnává jiné věty. Jeden běh navíc u každé věty jen jednou losuje odpověď modelu. Proto vznikly dva další živé běhy na každé straně: „před“ = build `88245889` ve vlastním worktree, „po“ = HEAD, každý na čerstvě spuštěném serveru, aby nebyla prázdná cache odpovědí. Spolu s `baseline.json` a `after.json` jsou to tři běhy na stranu (180 her). Věty jsou seřazené podle žánru rychlé verze, ten se nemění. Obě strany počítá stejný řetěz věrnosti z HEAD.

| tři běhy na stranu | read | drawn | role | roleNamed | AI |
|---|---|---|---|---|---|
| před | 0,788 | 0,744 | 0,714 | 0,404 | 168/180 |
| po | 0,788 | **0,748** | **0,723** | **0,431** | 167/180 |

| žánr rychlé verze | vět | read před → po | drawn před → po | role před → po |
|---|---|---|---|---|
| arena | 24 | 0,784 → 0,783 | 0,751 → 0,763 | 0,705 → 0,717 |
| duel | 2 | 0,583 → 0,542 | 0,583 → 0,542 | 0,583 → 0,542 |
| flap | 1 | 1 → 1 | 1 → 1 | 1 → 1 |
| platformer | 2 | 0,833 → 0,833 | 0,708 → 0,708 | 0,708 → 0,708 |
| quest | 9 | 0,672 → 0,680 | 0,530 → 0,538 | 0,505 → 0,516 |
| rhythm | 2 | 0,583 → 0,583 | 0,583 → 0,583 | 0,583 → 0,583 |
| runner | 5 | 0,978 → 0,933 | 0,978 → 0,933 | 0,911 → 0,933 |
| shooter | 3 | 1 → 1 | 1 → 1 | 1 → 1 |
| throw | 4 | 0,875 → 0,875 | 0,875 → 0,875 | 0,875 → 0,875 |
| timing | 3 | 0,333 → 0,333 | 0,333 → 0,333 | 0,333 → 0,333 |
| voyage | 5 | 0,900 → 0,950 | 0,850 → 0,900 | 0,850 → 0,900 |

Poklesy v živé AI verzi, věta po větě:

- **d19 „plan a budget for my family vacation“ (arena)** – opraveno (`911f6f25`). AI teď píše prostředí „Family vacation“ a pro dovolenou neexistovala žádná sada vzhledu, takže scéna kreslila louku a místo z věty nebylo vidět. Teď „vacation“ a „holiday“ kreslí pláž, „winter holiday“ zůstává sníh. Před opravou byla arena 0,784 → 0,769.
- **d05 „a sloth tries to cross a busy jungle highway“ (runner)** – neopraveno. Režisér volí mezi běžcem a plavbou zhruba půl na půl a plavba sloveso „cross“ nečte. Starý režisér zvolil běžce v 5 ze 7 pokusů, nový v 5 z 15. Hypotéza, že model mate obsazení výchozího bodu (had a banán z prostředí, které věta nejmenuje), byla změřena a vyvrácena: bez nich zvolil běžce v 1 z 5 pokusů, s nimi ve 3 z 5. Přidat „cross“ mezi slovesa běžce by přehodilo žánr i větám, kde „cross“ hlavní sloveso není („freezes a waterfall to cross a canyon“).
- **d18 „a sumo wrestler pushes rivals out of a bouncy ring“ (duel)** – náhoda modelu. Před: 0,75 / 0,25 / 0,75. Po: 0 / 0,75 / 0,75 a tři běhy navíc 0,75 / 0,25 / 0,75. Nula je jediný případ, kdy AI vrátila rychlou verzi (`UNCHANGED`); rychlá verze té věty má soupeře „car“ v „dusty town“, a to platí už před P39.

**Odpověď na otevřenou otázku plánu („má `does` rozhodovat žánr?“):** z měření to nevyplývá. Jediná věta, kde se žánr AI posunul (d05), se neposunula kvůli obsazení, ale kvůli tomu, jaký žánr si model vybere.

## Jak běh zopakovat

```
npm run build
set PLAY_DIRECTOR_CALLS_PER_CALLER=1000   # jinak po 12 voláních MODEL_UNAVAILABLE
set WORLDSMITH_CALL_CAP=1000
# + proměnné z .claude/start-demo.cmd (WORLDSMITH_MODEL_ENDPOINT=codex-cli …), předplatné, žádné placené API
node node_modules/next/dist/bin/next start -p 3100
node --experimental-strip-types scripts/play-fidelity.mjs run --base http://127.0.0.1:3100 --set dev --run <id> --gpu
node --experimental-strip-types scripts/play-fidelity.mjs roles --run <id> --set dev --out evals/play/p39/<baseline|after>.json
```

Běh posílá věty po jedné (~15–40 s na větu přes `codex-cli`); výsledky a snímky jsou v `evals/play/fidelity/runs/<id>/` (gitignorované).
