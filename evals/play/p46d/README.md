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

## Po P46D (běh soudce `after`, větev P46D `6f3be970`; tehdejší `after.json` je v gitu u `29cc066f`, dnešní přepsal R2)

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

## Po R2 (`after.json`, běh soudce `r2`, větev P46D `e202a6dd`)

R2 dal řízení a skákačce styl podle prostředí (poušť = široké zatáčky s turbem, les = krátké klikaté, supermarket = rozcestí, město = šikany a zúžení; les = schody, bažina = lekníny, dálnice = desky s hroty, hrad = věž) a scéna řízení kreslí skutečnou šířku silnice. **Cíl T7 je splněný u všech tří žánrů.**

- **Metrika:** nad prahem 0,3 je všech 18 dvojic (dřív 10/18). Běžec 6/6, řízení 6/6, skákačka 6/6. Nejtěsnější je p1–p2 (les proti bažině) s 0,307.
- **Slepý soudce:** „liší se tvarem“ u 16 z 18 dvojic (89 %, dřív 61 %). Běžec 5/6, řízení 5/6, skákačka 6/6.
  - „Stejné“ jsou r1–r4 („rovná trať s příčnými zábranami“ u obou) a s1–s3 (obě „úzká silnice se střídavými výběžky zdí“: s1 nemá prostředí a semínko mu vybralo šikany, s3 je les s klikatými zatáčkami).
  - Skákačku soudce poprvé rozlišil i bez hradu: lekníny popisuje jako „řadu úzkých oddělených plošin“, dálnici jako „souvislou trať s překážkami“.
- **Dvě semínka téže věty:** běžec 0,41–0,55, řízení 0–0,50, skákačka 0,06–0,65. U lesa (s3) a pouště (s4) dávají semínka **stejné pořadí vzorů**: na čtyřech semíncích publikace pokaždé tatáž řada (les: zatáčka, turbo, klikatá…; poušť: turbo a zatáčka střídavě). Věta teď tvar vybírá. Jestli se tyto tratě liší aspoň ohybem zatáček, měřidlo nečte (podpis řízení nemá křivku), ověřené to není.
- **Scéna řízení na snímcích** (s1, s3, kontrola okem): souvislé mantinely, zúžení a šikany jsou vidět jako schodovité výběžky zdí, silnice nikde nemizí.
- **Obtížnost:** se schody na váze 6 vyhrál začátečník v lese `jump.escape` 19 z 20 a `platformer.default` 15 z 20 (strop 14). Koruny teď schody ředí kyvadly a hroty: 11/20 a 10/20, intermediate 20/20. Řízení: 14/19 a s `+shoot` 7/16, v pásmu.
- **Oprava po cestě:** styl bez chodby s ostny mohl vylosovat úroveň bez jediného hrotu (koruny se starými vahami 13 z 60 úrovní), takže nebezpečí z věty nemělo tělo (`platform-probe` semínka 8 a 19). Poslední deska teď dostane hrot, když úroveň žádný nemá.
- **Zábava panelu P45** (`fun-after.json` přeměřený po R2 proti `fun-baseline.json` z P46A): 40/40 hratelných. Medián mrtvého času 5,36 → 4,98 s, gradace 0,55 → 0,60, podíl her s finále 0,23 → 0,23, medián počtu chování 1 → 1. Nic není horší.
- **Telefon:** `e2e/p35-perf.spec.ts` 17/17 zelený (Pixel 7, server nad buildem `e202a6dd`).
- **Celá sada** (13. 10., stroj vytížený jinými relacemi na ~65 %): 13 091 z 13 129. Samostatně zůstalo červené:
  - `sections.test` – regrese R2 (lekníny s 8 mouchami stejně dlouhé jako se 3), opraveno `07180360`.
  - `dare-board.test` 3 testy – test bere první startovní hru, která splní jen část jeho podmínek; P46D změnil, která to je. Úkol R4.
  - `upgrade.test` „pod 3 s“ – rychlá publikace běžce trvá 3,0–3,6 s, na základu P46D projde. Ověření hry s křečkem trvá ~1010 ms místo ~720 ms. Úkol R5.
  - `upgrade-action-lost.test` 2 testy – červené už na základu P46D (`491079b7`, P45), nejsou z P46D.
  - `submission-check.test` – ve worktree chybí gitignorovaný `plans/P8-odevzdani.md`.
  - Ostatní červené (limity 30 s a rychlostní meze) samostatně prošly.
