# P46D – měřidlo rozmanitosti tratí

Majitel 12. 10. 2026: „hry jsou si podobné“. Měřidlo říká číslem, jestli dvě věty téhož žánru dají jinak postavenou trať.

## Co měří

- **Podpis tvaru** (`variety.ts`) se počítá z těles hotového světa, ne ze jmen modelů. Jiný model, barva nebo jméno druhu podpis nepohne. Vzory se poznávají ze struktury (pruhy, mezery, zdi, výšky), ne ze štítků generátoru.
  - Běžec: cik-cak, řetěz skoků, ulička skluzu, rozcestí, most, tunel, stezka věcí, volný úsek; zbytek `mixed`. Křivka a výška trati přijdou ze scény (T3) a do vzdálenosti se přidají, když je aspoň jeden podpis má.
  - Řízení: dlouhá zatáčka (`sweep`), krátká (`kink`), šikana, zúžení, rozcestí, rovinka s turbem a bez.
  - Skákačka: schody, výstup, rostoucí mezery, chodba s hroty, pohyblivá plošina, voda, odpočinek u checkpointu.
- **Vzdálenost** 0–1: polovina rozdíl zastoupení vzorů, polovina rozdíl dvojic sousedních vzorů.
- **Práh „jiný tvar“ 0,3.** Kalibrace: dvě semínka téže věty dnes dají 0 u všech 12 vět, ručně různé tratě 1.
- **Slepý soudce**: screenshot každé hry v čase t = 10 s běhu robota, dvojice téhož žánru vedle sebe jako `sheet.png` v prázdném adresáři, otázka „liší se tratě tvarem?“.

## Spuštění

```
P46D_OUT=evals/play/p46d/baseline.json npx vitest run --config vitest.measure.mts evals/play/p46d/variety.measure.ts
```

Se soudcem navíc server nad buildem webpack: `npm run build`, `node node_modules/next/dist/bin/next start -p 3247`, pak k příkazu `P46D_BASE=http://127.0.0.1:3247 P46D_RUN=baseline` (volitelně `P46D_GPU=1`). Snímky a odpovědi leží v gitignorovaném `evals/play/fidelity/runs/p46d-<run>/`.

## Výchozí stav (`baseline.json`, větev P45 `491079b7`)

- Všech 18 dvojic (6 na žánr) má vzdálenost 0, tedy 0 % nad prahem.
- Běžec: celá trať je jeden vzor `mixed` (náhodné řady, žádný poznatelný úsek).
- Řízení: u všech čtyř vět stejná řada „rovinka, 5× dlouhá zatáčka střídaná s rovinkou s turbem“.
- Skákačka: u všech čtyř vět stejná řada se dvěma checkpointy, chodbou s hroty kolem pohyblivé plošiny ve třetím úseku.
- Slepý soudce na baseline zatím nedoběhl (`judge: null`).
