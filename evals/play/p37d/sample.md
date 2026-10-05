# P37D T5 – druhý slepý soud nových modelů a velikost stažení hry

## Poznatelnost – 49 z 50 (98 %), práh 90 %

- **Vzorek:** 50 ze 129 modelů `gen3d-p37d` v katalogu (pilot + dávky 1–4), semínko **37045**, losuje `pure-rand`
  (`xoroshiro128plus`). Zopakování: `node scripts/p37d/judge-pick.mjs --seed 37045 --count 50 --out <adresář>`.
- **Otázka jiná než při přijetí:** při přijetí volné „co to je?“, tady „které z těchto pěti jmen sedí nejlépe?“.
  Čtyři návnady z `missing.json`, žádná se neshoduje s žádným jménem modelu. List čtyř pohledů se kreslí z LOD0,
  který jde do hry (po `normalizeModel`), ne ze souboru výroby. Soudce astra přes předplatné, prázdný adresář,
  soubor `sheet.png` – vývojové měření, odpovědi mimo repo (`D:/caches/p37d/t5/pick.json`), nikdy trénovací data.
- **Vzorek:** gnome, garden gnome, energy drink, peach, monster truck, seagull, paintball gun, soap, tennis ball,
  sunglass, wallet, santa, eraser, broom, ray gun, shrimp, kettle, paint can, medal, athlete, angel, roller skate,
  seaweed, fisherman, space suit, candy cane, lipstick, potato, bowling ball, baseball, cashier, unicycle,
  gingerbread man, robot arm, cassette, bacon, toothbrush, investor, puzzle piece, game controller, easel,
  pitchfork, briefcase, chocolate, hat, burrito, frog, wrench, pretzel, dumpling.
- **Špatně 1:** dumpling – soudce vybral „onion“ z [onion, net, dumpling, milk, jetpack]. Už při přijetí to byla
  jen druhá volba („garlic bulb“). **Vyřazený z katalogu** (`promote-batch.mjs --drop gen3d-dumpling`);
  knihovna má 128 nových modelů.
- Hraniční modely z prohlédnutí dávek (peach, onion, hockey puck, crystal ball, easter egg) – do vzorku padla
  peach a prošla.

## Velikost stažení jedné hry – +0,4 %, strop ±5 %

Změřeno 4. 10. sondou `e2e/play-perf.spec.ts` (`transferSize` všech požadavků v čerstvém kontextu, tedy
s prázdnou cache): produkční build HEAD (`66e1f40b`) a build tagu `p37-base` (`ae2b8eb9`, vlastní worktree),
oba přes `next start` na 3374, stejné tři hry, profil desktop, 2 opakování. Obě opakování vyšla na bajt stejně.

| Hra | `p37-base` | HEAD | rozdíl | z toho JS | z toho GLB |
|---|---|---|---|---|---|
| běžec | 1 079 049 B, 47 požadavků | 1 083 670 B, 47 | **+0,43 %** | +4 625 B | 0 (9 souborů) |
| aréna | 1 137 086 B, 45 | 1 141 707 B, 45 | **+0,41 %** | +4 625 B | 0 (7 souborů) |
| mřížka | 1 108 699 B, 41 | 1 113 347 B, 41 | **+0,42 %** | +4 648 B | 0 (8 souborů) |

Celý přírůstek je index katalogu v klientském balíku (`src/play/arcade/models.ts` →
`@/assets/catalog-index.json`): 292 838 B → 338 482 B, po kompresi +4,7 KB, což sedí na naměřených +4,6 KB JS.
Nové modely se stahují, jen když je věta jmenuje – žádná ze tří her nestáhla jiný GLB ani o soubor víc.
Mobilní profil se neměřil (odvozeno, ne změřeno: přírůstek je v JS balíku, který je pro oba profily stejný).

Zopakování: build (`node scripts/p32/heavy.mjs -- npm run build`), server
`node node_modules/next/dist/bin/next start -p 3374`, pak
`FALLBACK_SMOKE_URL=http://127.0.0.1:3374 PERF_PROFILES=desktop PERF_REPEATS=2 PERF_OUT=<soubor> npx playwright test e2e/play-perf.spec.ts --project=chromium --grep @measure`.
