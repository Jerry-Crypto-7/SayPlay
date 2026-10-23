# P58A – co je ve větě, to porotce uvidí

Plán `plans/P58A-veta-je-videt-2026-10-23.md` (necommitovaný). Větev `features/P58A-veta-je-videt-2026-10-23` z `main` `1a3306eb` (po P57A).

## Zapečetěná sada (T1)

- **`holdout.json`** – 80 anglických vět, každá s hrdinou a s protivníkem nebo věcí. Napsal je 23. 10. Codex (`--effort high`, read-only, bez webu) v prázdném `mkdtemp`, kde ležel jen brief `holdout-brief.md` a schéma odpovědi: katalog, kód ani jiné sady neviděl. Vrátil 120 kandidátů, 60 „běžných“ a 60 se zvířetem, tvorem nebo postavou, pro kterou by hra model spíš neměla.
- **Výběr** (`scripts/p58a/seal-holdout.ts select`, v pořadí autora, bez čtení vět v relaci): 40 vět, kde některé slovo soudce (hrdina, protivník, bez něj věc – `nounsOf`) nemělo v den pečetění v katalogu přesný model (`heroChoice(…, 'enemy').level` ≠ `identity`, pole `outside`), a 40, kde ho měla všechna. Z kandidátů bylo mimo katalog 58, uvnitř 62; žádný nebyl ve známé sadě ani duplicitní. Nevybraní kandidáti zůstali mimo repo.
- **SHA-256 nad LF bajty: `84812b185bf2091355d9a06df48863b9f726ab8be857a393a167f0747c7def16`** (`seal.ts`).
- `__tests__/holdout.test.ts` hlídá otisk, počty, tvar, 40 vět `outside` (věty „uvnitř“ musí mít přesný model i dnes – katalog jen roste) a nulový průnik po `normalizeSentence` se všemi sadami `KNOWN_SETS` v `seal.ts` (p30, p43, p45, p52, p54c, p55, demand, p56a včetně otevřené zapečetěné sady, p56b, p57). Na výstup jen id. Otevře ji jen T9, jednou, přes `openSealedOnce`.
- Codex: 1 volání.

## Výchozí stav na dev (T1)

Dev sady: `evals/play/p56a/audit-12.json` (12 vět auditu) a `evals/play/p56a/holdout.json` (80 vět, otevřená v P56A T13, od té doby dev; plán ji jmenuje podle záznamu `holdout-opened.json`).

**Jak se měří** – stejně v T1 i v T8, ať se liší jen to, co P58A kreslí:

1. **Čtení věty nahrané jednou:** `read-all.cmd` přečte obě sady lokálním gpt-oss-20b (`ops/llm/start.ps1 -Role fallback`, zámek GPU) přes `evals/play/p56a/read-set.ts` do `readings/`. Server hry je pak dostává z přehrávače `scripts/p58a/reader-replay.mjs` (`PLAY_READER=on`, `PLAY_READER_ENDPOINT=llamacpp:http://127.0.0.1:8793`); věta bez čtení dostane 503 a hraje bez čtečky jako při nahrávání.
2. **Hra a snímek:** `npm run build` + `next start`, `evals/play/p56a/visible.mjs play` – plátno 1280×800 po 3 s hry robota, text stránky skrytý.
3. **Slepý soud:** `visible.mjs judge` – audit-12 Codex (srovnatelné s P56A T12), otevřená sada P56A Opus 5.5 (`--judge claude`, stejná otázka, prázdný adresář jen se `sheet.png`). Codex má strop 30 volání za den; soudce je pevný po sadě, takže T8 porovnává stejného soudce se stejnou sadou.
4. **Souhrn:** `evals/play/p58a/visibility.mjs` → `baseline.json` (celé věty, slova, hrdina, protivník/věc, po sadách i dohromady).

**Výsledek na `1a3306eb`** (`baseline.json`):

| | Celé věty | Slova | Hrdina | Protivník / věc |
|---|---|---|---|---|
| audit-12 (Codex) | 4/12 | 9/18 | 2/6 | 7/12 |
| otevřená sada P56A (Opus) | 6/80 | 26/128 | 15/59 | 11/69 |
| **dohromady** | **10/92 (0,11)** | **35/146 (0,24)** | 17/65 | 18/81 |

Cíl P58A je ≥ 0,5 celých vět a ≥ 0,75 slov. P56A T13 měřila na téže sadě 13/80 a 38/128 – jiným soudcem (Codex) a před P56B/P56C/P57A, takže čísla nejsou srovnatelná; srovnává se jen T8 proti tomuto souboru.

**Co měření ukázalo mimo viditelnost** (nálezy pro jiné plány, P58A je neopravuje):

- **37/92 her je řetěz miniher P56C** (`__playShell` s `round`/`playRound`, bez ručních hodin `byHand`): robot se nepustí, snímek je po 3 s skutečného času po `start()`. V P56A T13 to bylo 0/80. Všech 37 stránek hlásí **chybu hydratace Reactu #418** (HTML ze serveru nesedí s klientem) – kandidát pro P58C.
- **`next start` přestal odpovídat na `POST /api/play/games`** dvakrát po ~55 hrách (proces drží ~70 % jádra, hlavičky nepřijdou do 300 s). Táž věta na čerstvém serveru projde za 3,6 s. Shoduje se s pamětí „server po ~24 bězích přestane odpovídat“; pro veřejné demo je to riziko (P58C/P59).
- s45 (`runner.default`) hlásí na stránce `Cannot read properties of null (reading 'x')`.

## Proč slova chybí (T2)

**Jak:** druhý průchod obou dev sad se stejnými nahranými čteními (`scripts/p58a/play-sets.mjs … --spec`) uloží ke každé hře spec, jaký kreslil server, a sondu `__playFrame` v okamžiku snímku (obdélník hrdiny, cíle a položek na plátně). Snímky leží mimo repo (`D:/tmp/p58a/frames/{audit-12,p56a-holdout}`, 92/92). `scripts/p58a/why-unseen.mjs` pak zařadí každé neviděné slovo z `baseline.json` do první platné třídy → `why.json`:

```
node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs scripts/p58a/why-unseen.mjs --baseline evals/play/p58a/baseline.json \
  --frames D:/tmp/p58a/frames/audit-12=evals/play/p56a/audit-12.json --frames D:/tmp/p58a/frames/p56a-holdout=evals/play/p56a/holdout.json \
  --out evals/play/p58a/why.json --missing evals/play/p58a/missing-nouns.json
```

**111 neviděných slov ze 146:**

| Třída | Co znamená | Hrdina | Protivník / věc | Celkem | Úloha |
|---|---|---|---|---|---|
| `no-role` | slovo nenese žádná role hry (pizza → „fruit“, king → „ogre“, krokodýl nikde) | 0 | 44 | **44** | T6 |
| `no-model` | role je, model je výchozí náhrada (husa → závodní auto, gopher → robot) | 5 | 4 | 9 | T6, T7 |
| `off-screen` | tělo role není v záběru | 0 | 4 | 4 | T4 |
| `too-small` | tělo je pod prahem velikosti | 0 | 0 | 0 | T3 |
| `look` | správná role, přesný model (`identity` 54/54), v záběru – soudce ho přesto nepoznal | 43 | 11 | **54** | T3, T5 |
| **celkem** | | 48 | 63 | 111 | |

**Velikost na snímku** (podíl výšky plátna; poznáno / slov s rolí, modelem a v záběru):

| | 0–5 % | 5–10 % | 10–15 % | 15–20 % | 20–30 % | 30–50 % | nad 50 % |
|---|---|---|---|---|---|---|---|
| hrdina | 0/2 | 3/7 | 4/21 | 3/9 | 4/15 | 2/4 | 0/1 |
| protivník / věc | 3/6 | 5/8 | 1/1 | 1/3 | 1/2 | – | 0/2 |

Práh platí, jen když nejlepší řez (aspoň 3 slova na každé straně) má nad sebou poznáno aspoň polovinu a aspoň dvakrát častěji než pod sebou (`thresholdOf`). **Ani pro hrdinu, ani pro protivníka nevyšel** (`threshold: null`): hrdina je poznaný v pásmech 5–50 % mezi pětinou a polovinou případů bez trendu nahoru, nejlepší řez (30,6 %) má nad sebou 2/5. Proto `too-small` = 0 a všechno takové je `look`. První rozbor bez téhle podmínky dal `too-small` 42 – řez na 38,7 % se dvěma slovy nad sebou, artefakt.

**Kdy soudce sám píše, že je tělo malé** („small / tiny / distant / far / little“ v odpovědi, `calledSmall`; malé / slov pod hranou a nad ní):

| Hrana výšky | 10 % | 15 % | 20 % | 25 % |
|---|---|---|---|---|
| hrdina pod / nad | 8/9 · 15/50 | 18/30 · 5/29 | **21/39 · 2/20** | 22/49 · 1/10 |
| protivník / věc pod / nad | **7/14 · 1/8** | 7/15 · 1/7 | 7/18 · 1/4 | 7/18 · 1/4 |

**X a Y pro T3:** práh poznání nevyšel, proto T3 bere hranu, nad kterou soudce tělo skoro nikdy nenazve malým: **hrdina ≥ 20 % výšky plátna** (nad ní 2/20, pod ní 21/39), **protivník či věc ≥ 10 %** (nad ní 1/8, pod ní 7/14).

**Inference (ne měření):**
- Zvětšení hrdiny nad 20 % odstraní výtku „malý“, ale poznání samo nezaručí: hrdina nad 20 % je poznaný 6/20, zhruba jako pod (10/39). Soudce u 25 z 54 `look` píše „small“ (`lookCalledSmall`), zbytek je tvar modelu nebo scéna; kolik dá velikost sama, změří T8.
- Největší jednotlivé díry jsou `no-role` u protivníka či věci (44, hra slovo z věty vůbec nekreslí – T6) a `look` u hrdiny (43 – T3, T5).

**Chybějící modely – `missing-nouns.json`:** 72 slov z popisků dev sad a nahraných čtení bez přesného modelu (`heroChoice(…, 'enemy').level` ≠ `identity`), podle počtu vět v poptávce a dev sadách. Vrchol: basket 10, pad 10, gopher 4, mole 4, vegetable 4, honey 3, leaf 3, master 3. Ne-jména ze čtení („you“, „can“, „three“), místa a abstrakta vyřazuje `ops/gen3d/not-nouns.txt` a `abstract` z `evals/play/p37d/common-nouns.json`; T2 do `not-nouns.txt` přidal terén a skupiny bez vlastní podoby (highway, path, line, hole, crater, swarm, crew…). Jednotné číslo bere lexikon draftu (`singular`: zombies → zombie, ne „zomby“).

## Dogenerované modely (T7)

`scripts/p58a/gen-models.mjs` nad `gen-nouns.json`, výsledek každého slova v `gen-models.json`.

- **Generovalo se 36 ze 72 slov** – jen ta, kde nejbližší model z T6 slovo neukazuje (gopher jako křeček, marine jako astronaut, rail jako lokomotiva, trout jako zlatá rybka). Vynechané: 16 slov, jejichž náhrada už sedí (basket → nákupní košík, honey → hrnec medu, lord → král, shoplifter → zloděj), dvojznačné pad a board a 18 slov bez jedné věci (riddle, clue, circle, citizen, guest…).
- **Prošlo 7 z 36:** bun, rail, blacksmith, dumpling, hostage, lizard, trout – skóre slepého Opuse ≥ 7 **a** soudce model nazval slovem věty. Všech 7 hra teď bere jako přesný model (`heroChoice` → `identity`); trout má v `catalog-motion.json` třídu swimmer.
- **Tři kola:** zadání `b`/`a` se semínkem 1, pak 2, pak semínka 3–4 s předkontrolou obrázku Opusem (vzor P46F). Kola přidala 5, 1 a 1 model. Předkontrola nepomohla: obrázek soudce pozná, 3D z něj pak dostane 3–6 („Pine cone“ 4, „Cheetah“ 5, „Bulldog“ 5).
- **Poznané, ale pod 7:** snowplow 6, bongo 6, marine („Toy soldier“) 6, bulldog 5, cheetah 5, pinecone 4. **Nepoznané:** firecracker 8 jako „Dynamite stick“, lid 7 jako „Cooking pot“, patty 7 jako „Cake / pie“, branch 7 jako „Bare tree“. Brána kvality sítě (`inconsistent face winding`) shodila 20 pokusů, nejvíc u mole (5/6) a vegetable.
- Odmítnutá slova zůstávají na nejbližším modelu z T6.

**Inference:** platí strop řetězu, ne počtu kol. 3D z TRELLIS u zvířat a drobných věcí končí na 4–6 z 10 i z poznaného obrázku. Další kolo se stejným řetězem by přidalo jednotky. Víc by mohla dát ruční úprava v Blenderu nebo CC0 modely pro zvířata (bulldog, cheetah).

## Dev kontrola po T3–T7 (T8)

Na `9b0a37f7` stejně jako T1: tatáž nahraná čtení, tentýž soudce po sadě (audit-12 Codex, otevřená sada P56A Opus). Souhrn `dev-result.json` (krok 4 potřebuje `node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p58a/visibility.mjs …`). Všech 92 her proběhlo na jednom serveru bez zaseknutí.

| | celé věty | slova | hrdina | protivník/věc |
|---|---|---|---|---|
| audit-12 (Codex) | 2/12 (T1 4/12) | 7/18 (9/18) | 2/6 (2/6) | 5/12 (7/12) |
| otevřená P56A (Opus) | 9/80 (6/80) | 32/128 (26/128) | 17/59 (15/59) | 15/69 (11/69) |
| **celkem** | **11/92 = 0,12** (0,11) | **39/146 = 0,27** (0,24) | 19/65 (17/65) | 20/81 (18/81) |

- Proti T1: 8 slov nově vidět, 4 ztracená (shark, asteroid, pigeon, bulldog). Věty: 4 získané, 3 ztracené, rozdíl je v mezích šumu. Cíl 0,5 / 0,75 je daleko.
- **Proč dál chybí** (`why-unseen.mjs` nad `dev-result.json`, 107 neviděných, T2 111): no-role 32 (44), no-model 2 (9), off-screen 6 (4), too-small 42 (0, vše hrdinové), look 25 (54). Nejčastější neviděná slova: zombie 4, cat 3, walrus 3, pizza 2, skeleton 2.
- **Popisek jména (T5) soudce neviděl ani jednou:** je to text stránky a snímek `visible.mjs` text stránky skrývá. Porotce ve hře popisek uvidí, měření ne.
- **Precision (s06, s20, s44, okem):** hrdina v záběru vůbec není, je vidět jen lišta a sloupek. Věc na ručičce: s20 palačinky poznané (nově), s06 patty soudce četl jako sendvič, s44 kokos jako hnědý kotouč.

**Inference:** „too-small“ je ve skutečnosti „look“. Práh 30,7 % stojí na 4 hrdinech nad ním a 42 hrdinů má medián 21 % výšky plátna, tedy cíl T3 splňují. Zhruba 67 slov má správný model na obrazovce a soudce je přesto nepozná. 14 z těch 42 jsou hry precision/stack, kde sonda bere jako hrdinu houpající se díl a postava v záběru chybí – to je nejužší cílená oprava (T8, druhé kolo).

### Druhé kolo T8 – hrdina u načasování

**Co se zkusilo:** scéna načasování (`TimingScene`, žánry `timing.precision` a `timing.stack`) hrdinu věty vůbec nekreslila – rytmus ho měl vedle lišty, načasování ne. Teď stojí před věží za krajem kyvu, natočený ke kameře i k věži, 1,8 m (na šířku ~25 % výšky snímku), s poskokem po trefě (`f8e3c7c7`). Po prvním přefocení ho u s47 zakryl rámující kus kulis (ledový oblouk), proto je místo hrdiny pro kulisy zakázané (`30ba646d`). Popisek jména hrdiny jde v rytmu a načasování nad postavu, ne nad lištu nebo ručičku. Sonda záběru má hrdinou dál jezdce, testy záběru se nemění.

**Měření:** 22 her načasování (všechny v otevřené sadě P56A) přefocených na `30ba646d` a znovu posouzených Opusem, stejná nahraná čtení. Zbylých 70 her nese snímky a verdikty prvního kola z `9b0a37f7` – od té doby se změnila jen scéna načasování a textový popisek, který snímek skrývá. Souhrn `dev-result.json`.

| | celé věty | slova | hrdina | protivník/věc |
|---|---|---|---|---|
| audit-12 (Codex) | 2/12 | 7/18 | 2/6 | 5/12 |
| otevřená P56A (Opus) | 12/80 (kolo 1: 9/80) | 43/128 (32/128) | 27/59 (17/59) | 16/69 (15/69) |
| **celkem** | **14/92 = 0,15** (0,12) | **50/146 = 0,34** (0,27) | 29/65 (19/65) | 21/81 (20/81) |

- **Hrdina u her načasování: 11/16 poznaných** (kolo 1: 1/16, šest vět hrdinu soudci nejmenuje) – dítě, ochranka, opice, chobotnice, tučňák, kovář, papoušek, gumová kachna, tuleň, detektiv, děda. Nepoznaní: DJ kočka (obyčejná kočka), babička (čte se jako děda s cylindrem), kasař a operní pěvkyně (obecná postava), ještěrka (čte se jako raptor).
- Celé věty u načasování 0/22 → 3/22. Šum soudce: s06 „burger patty“ při prvním přefocení poznaný, při druhém ne (táž scéna, obrázek se liší jen kulisami).
- **Proč dál chybí** (96 neviděných): look 48 (hrdina 24, protivník/věc 24; přesný model `identity` 41), no-role 31 (vše protivník/věc), too-small 9, off-screen 6, no-model 2. Práh velikosti opět nevyšel (hrdina 20–30 % výšky poznaný 20/45).
- **Brána dev (0,5 celých vět, 0,75 slov) splněná není a jedna cílená oprava ji nepřiblíží.** Největší třída je teď „look“: správné tělo i model na obrazovce a soudce ho nepozná (generický člověk místo profese, kočka bez znaku DJ, ještěrka jako raptor). Druhá je no-role – věc, kterou hra nedostala do žádné role (zombie, náboj, šperk z věty).

**Inference:** zbylé body neleží v kameře ani velikosti. Profese a přívlastky („opera singer“, „dj cat“, „safecracker“) potřebují znak na modelu (rekvizita, kostým), zvířata přesnější model. To je práce na knihovně modelů, ne na scéně.
