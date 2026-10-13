# P46D – měřidlo rozmanitosti tratí

Majitel 12. 10. 2026: „hry jsou si podobné“. Měřidlo říká číslem, jestli dvě věty téhož žánru dají jinak postavenou trať.

## Co měří

- **Podpis tvaru** (`variety.ts`) se počítá z těles hotového světa, ne ze jmen modelů. Jiný model, barva nebo jméno druhu podpis nepohne. Vzory se poznávají ze struktury (pruhy, mezery, zdi, výšky), ne ze štítků generátoru.
  - Běžec: cik-cak, řetěz skoků, ulička skluzu, rozcestí, most, tunel, stezka věcí, volný úsek; zbytek `mixed`. Křivka a výška trati ze scény (T3, `trackPathOf`) se do vzdálenosti přidají, když je aspoň jeden podpis má.
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
- Slepý soudce (běh `baseline`): „liší se tvarem“ u 3 z 18 dvojic (17 %). Běžec 0/6, řízení 0/6, skákačka 3/6 – všechny tři jsou dvojice s p4 (hrad) a soudce u nich popisuje oblouk mostu, který je kulisa u hradu, ne tvar levelu. U ostatních píše „rovná široká trať, žádné zatáčky, rozcestí, mosty ani tunely“.

## Po P46D (`after.json`, běh soudce `after`, větev P46D `6f3be970`)

Cíl T7 (metrika ≥ 80 % dvojic nad prahem, soudce ≥ 70 % „liší se tvarem“) je splněný jen u běžce.

- **Metrika:** nad prahem 0,3 je 10 z 18 dvojic (56 %). Běžec 6/6, řízení 2/6, skákačka 2/6. Bez křivky ze scény by to bylo 7 z 18 (39 %); křivku plánoval už T1, do měření ji zapojil až T7.
- **Dvě semínka téže věty** se teď liší zhruba stejně jako dvě různé věty: běžec 0,41–0,55, řízení 0,14–0,34, skákačka 0,19–0,25. Tvar losuje semínko, věta ho nevybírá.
- **Slepý soudce:** „liší se tvarem“ u 11 z 18 dvojic (61 %, baseline 17 %). Běžec 5/6 (baseline 0/6), řízení 3/6 (0/6), skákačka 3/6 (3/6).
  - Řízení: rozdíl vidí jen tam, kde je na snímku zúžení („stepped width changes“). Jinak píše „rovná silnice bez zatáček“.
  - Skákačka: všechny tři „jiné“ dvojice jsou zase ty s p4 a soudce popisuje šikmý most u hradu, stejně jako v baseline. U ostatních: „rovná řada širokých plošin s mezerami“.
- **Proč skákačka vypadá pořád stejně (inference z kódu, neměřeno):** na nejlehčím stupni jsou vzory na pohled slabé. Schody jdou po půl schodu (0,2 m), mezery se „rozšiřují“ po 0,25 m a výstup má tři schody. Měřidlo je proto počítá jako `mixed`, protože čeká schod aspoň 0,4 m a výstup aspoň z 5 schodů. Vodu staví generátor jako bazén (`pool`), a ne jako hrot v mezeře, takže ji měřidlo nepočítá.
- **Zábava panelu P45** (`fun-after.json` proti `evals/play/p46/fun-baseline.json` z P46A): 40/40 hratelných. Medián mrtvého času 5,36 → 5,32 s, podíl her s finále 0,23 → 0,23, medián počtu chování 1 → 1, gradace 0,55 → 0,53. Gradace klesla o jednu větu: závod m03 má teď rovnoměrnou hustotu, protože turbo je na každé spojce.
- **Telefon:** `e2e/p35-perf.spec.ts` 17/17 zelený (Pixel 7, 4× pomalejší procesor, server nad buildem této větve).
- **Co dál:** řízení a skákačka jdou do úkolu R2 v plánu. T7 zůstává otevřený, sloučení čeká i na P46B v integrační větvi.
