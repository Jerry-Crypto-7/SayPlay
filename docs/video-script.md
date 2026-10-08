# Scénář odevzdávaného videa – Sayplay, 2:35

Tvrdý limit je **3:00** (`RULES.md` §2); tohle video má **2:35**, zbytek je rezerva na střih. Bez obličeje a bez rozpoznatelného hlasu (`RULES.md` §6), proto **anglické titulky, žádná narace**. Dokument je česky pro toho, kdo stříhá; titulky jsou anglicky pro porotce.

Příběh je jedna smyčka: **věta → hra → AI verze → výzva kamarádovi → žebříček → remix**, a pak důkaz, že to není demo na kolejích: věta porotce mimo kategorii a další cizí věty. Každý záběr je skutečný prohlížeč nad buildem, žádná fixtura vydávaná za generaci.

**Klipy:** sloupec `Scéna` je zároveň jméno klipu. `e2e/demo-capture.spec.ts` ho čte z této tabulky a natočí každou scénu dvakrát, `videos/raw/<scéna>-desktop.webm` (1920 × 1080) a `videos/raw/<scéna>-phone.webm` (390 × 844); `dare-friend` má navíc klip kamaráda `dare-friend-<profil>-friend.webm`. Stopáž a povinné scény hlídá `node scripts/video-check.mjs docs/video-script.md`.

## Časová osa 2:35

| Čas | Scéna | Věta k zadání | Co je vidět | Titulek |
|---|---|---|---|---|
| 0:00–0:15 | `say-to-play` | `A knight fights a three-headed hydra at the castle gates.` (`JUDGE_PICKS` f22) | `/play`, do pole se píše věta (ne klepnutí na kartu), **Make it!**. Adresa přejde na `/play/<id>` a hra hned běží: rytíř bojuje s hydrou, sloveso se poprvé ukáže jako krátký popisek. | `Say a game.` → `One sentence in. A game you can play, right away.` |
| 0:15–0:35 | `ai-version` | stejná hra | Proužek „Full-detail version ready“ s tlačítkem **Play it**; otevře se nová hra, kterou navrhl AI režisér, s odkazem na rychlou verzi. Hra se dohraje do „You did it!“. | `Meanwhile an AI director designs a full-detail version of your sentence.` |
| 0:35–1:05 | `dare-friend` | stejná hra | Po výhře **Dare a friend to beat it** → „Link copied. Go dare someone.“ Odkaz otevře druhé okno na telefonu bez účtu, kamarád hraje proti duchovi vítězného běhu, „You beat it!“ a **Dare back**. | `Win, then dare a friend. The link plays anywhere, no account.` → `They race your ghost.` |
| 1:05–1:20 | `leaderboard` | stejná hra | Po výhře kamaráda žebříček hry: nejlepší ověřené běhy, vlastní řádek zvýrazněný, „You're #2 of 3“. | `Every run is replayed on the server before it counts.` |
| 1:20–1:40 | `remix` | stejná hra | Čip **Make it harder** → nová hra; rodokmen ukazuje rodiče, původní hra je beze změny. | `Change one thing and get a new game. The original stays as it was.` |
| 1:40–2:00 | `off-category` | `a long queue at the pharmacy on a friday afternoon` (`evals/play/p37a/dev-150.json` n19) | Věta, která hrou není, se napíše do pole na `/play`; vznikne hra s cílem „Dodge the long queues!“ a dá se hrát. | `Not a game idea? It still becomes one.` |
| 2:00–2:25 | `more-sentences` | `A space marine shoots alien bugs in a mining colony` (s037), `a penguin that slides down a glacier, jumps over seals and catches fish` (h10), `a kangaroo jumps over cars then collects coins on the highway` (m16), `a unicorn gallops across a rainbow to reach a castle in the clouds` (f08) | Rychlá montáž: každá věta do pole, **Make it!**, pár sekund hry. Čtyři různé žánry a ovládání. | `Your sentence, not ours.` |
| 2:25–2:35 | `close` | – | Tmavé plátno, název a adresa dema. | `Sayplay. Say it. Play it.` |

**Součet 2:35.** Kde se škrtá, škrtá se odzadu v `more-sentences`, nikdy ve smyčce `say-to-play` → `remix`.

## Co platí při natáčení

- **AI verze potřebuje klíče a nasazení.** Bez nich `ai-version` natočí rychlou verzi a skript vypíše `AI version unavailable – re-run after deploy`; finální klip se točí proti nasazenému demu (`FALLBACK_SMOKE_URL=<demoUrl>`).
- **Žebříček přichází se sloučením P44B.** Do té doby klip `leaderboard` ukáže jen obrazovku po výhře kamaráda; natáčí se znovu po sloučení.
- **Věty jsou doslova ty měřené**, i s malým písmenem na začátku – jiný zápis měřený není. Pět vět z `JUDGE_PICKS` (`src/components/play/starters.ts`) dalo v měření hru za 0,5–0,65 s na telefonu i na desktopu (`e2e/first-visit.spec.ts`, `@measure`).
- **Psaní věty se nezrychluje.** Zrychlit smí jen montáž `more-sentences`, a pak s viditelným označením.

## Co se netočí, a proč

- **Žádné časy v titulku bez běhu, ze kterého pocházejí.** Veřejná čísla (čas do hry, čas AI verze) přijdou z jednoho běhu na nasazeném demu (P31 T3); titulek „in N seconds“ až potom.
- **Žádná čísla o objemu práce** – ani v titulku, ani v záběru na terminál nebo git.
- **Žádný firemní branding, paleta ani font zaměstnavatele** (`RULES.md` §6). Barvy a písmo jsou z `docs/brand/`.
