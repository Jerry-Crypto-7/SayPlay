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
