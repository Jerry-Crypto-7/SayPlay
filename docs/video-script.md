# Scénář odevzdávaného videa – Sayplay, 2:35

Tvrdý limit je **3:00** (`RULES.md` §2); tohle video má **2:35**, zbytek je rezerva na střih. Bez obličeje a bez rozpoznatelného hlasu (`RULES.md` §6), proto **anglické titulky, žádná narace**. Dokument je česky pro toho, kdo stříhá; titulky jsou anglicky pro porotce.

Příběh je jedna smyčka: **věta → hra → AI verze → výzva kamarádovi → žebříček → remix**, a pak důkaz, že to není demo na kolejích: věta porotce mimo kategorii a další cizí věty. Každý záběr je skutečný prohlížeč nad buildem, žádná fixtura vydávaná za generaci.

**Klipy:** sloupec `Scéna` je zároveň jméno klipu. `e2e/demo-capture.spec.ts` ho čte z této tabulky a natočí každou scénu dvakrát, `videos/raw/<scéna>-desktop.webm` (1920 × 1080) a `videos/raw/<scéna>-phone.webm` (390 × 844); `dare-friend` má navíc klip kamaráda `dare-friend-<profil>-friend.webm`. Stopáž a povinné scény hlídá `node scripts/video-check.mjs docs/video-script.md`.

## Časová osa 2:35

| Čas | Scéna | Věta k zadání | Co je vidět | Titulek |
|---|---|---|---|---|
| 0:00–0:15 | `say-to-play` | `a knight fights goblins in an arena` (QA P71 ok, AI verze hotová) | `/play`, do pole se píše věta (ne klepnutí na kartu), **Make it!**. Adresa přejde na `/play/<id>` a hra hned běží: rytíř bojuje se skřety v aréně, nad postavami se při prvním objevení krátce ukáže jméno (P58A), sloveso jako krátký popisek a nápověda ovládání hned po startu. | `Say a game.` → `One sentence in. A game you can play, right away.` |
| 0:15–0:35 | `ai-version` | stejná hra | Proužek „Full-detail version ready“ s tlačítkem **Play it**; otevře se nová hra, kterou navrhl AI režisér, s odkazem na rychlou verzi. Hra se dohraje do „You did it!“. | `Meanwhile an AI director designs a full-detail version of your sentence.` |
| 0:35–1:05 | `dare-friend` | stejná hra | Po výhře **Dare a friend to beat it** → „Link copied. Go dare someone.“ Odkaz otevře druhé okno na telefonu bez účtu, kamarád hraje proti duchovi vítězného běhu, „You beat it!“ a **Dare back**. | `Win, then dare a friend. The link plays anywhere, no account.` → `They race your ghost.` |
| 1:05–1:20 | `leaderboard` | stejná hra | Po výhře kamaráda žebříček hry: nejlepší ověřené běhy, vlastní řádek zvýrazněný, „You're #2 of 3“. | `Every run is replayed on the server before it counts.` |
| 1:20–1:40 | `remix` | stejná hra | Čip **Make it harder** → nová hra; rodokmen ukazuje rodiče, původní hra je beze změny. | `Change one thing and get a new game. The original stays as it was.` |
| 1:40–2:00 | `off-category` | `a long queue at the pharmacy on a friday afternoon` (`evals/play/p37a/dev-150.json` n19; QA P71 ji nehrála, ověřit na zkušebním nasazení) | Věta, která hrou není, se napíše do pole na `/play`; vznikne hra a dá se hrát. | `Not a game idea? It still becomes one.` |
| 2:00–2:25 | `more-sentences` | `a fox runs through the city dodging cars` (runner), `cowboy duel at high noon, first to shoot wins` (duel), `a ninja slices flying watermelons` (slice), `a black hole swallows the cars in the city` (hole), všechny QA P71 ok | Rychlá montáž: každá věta do pole, **Make it!**, pár sekund hry. Čtyři různé žánry a ovládání. | `Your sentence, not ours.` |
| 2:25–2:35 | `close` | – | Tmavé plátno, název a adresa dema. | `Sayplay. Say it. Play it.` |

**Součet 2:35.** Kde se škrtá, škrtá se odzadu v `more-sentences`, nikdy ve smyčce `say-to-play` → `remix`.

## Co platí při natáčení

- **AI verze potřebuje klíče a nasazení.** Bez nich `ai-version` natočí rychlou verzi a skript vypíše `AI version unavailable – re-run after deploy`; finální klip se točí proti nasazenému demu (`FALLBACK_SMOKE_URL=<demoUrl>`).
- **AI verze přijde až za minutu** (p50 57 s, p95 93 s, `evals/play/p58b/director.md`). Čekání se v `ai-version` stříhá s viditelným označením („a minute later“), nikdy se nevydává za okamžité.
- **Telefonní klipy jdou natočit i na iPhonu** – Safari a WebKit jsou od P58C zelené (`e2e` WebKit 42/42).
- **Věty jsou doslova ty z QA P71** (`evals/play/p71/qa/findings.json`, 5. 11.), i s malým písmenem na začátku – jiný zápis prohraný není. Věta se v QA změní na „issue“ → vyměnit ji tady i v `e2e/demo-capture.spec.ts` za jinou „ok“.
- **Natočení klipů na finální verzi** (po nasazení commitu řezu, s klíči v produkci):
  `FALLBACK_SMOKE_URL=<demoUrl> npx playwright test e2e/demo-capture.spec.ts --grep @measure --workers=1`
  Klipy padnou do `videos/raw/` (gitignorované). **Zkušební záznam 5. 11.** (místní `next start`, bez klíčů): 17/17 testů, 18 klipů za 10 min; `ai-version` natočila jen rychlou verzi a `leaderboard` nenašel „You're #N of M“ – obojí ověřit na zkušebním nasazení, než se točí finále. Zkouška bez placeného režiséra: `npm run build`, `next start -p 3217` a `E2E_PORT=3217 FALLBACK_SMOKE_URL=http://127.0.0.1:3217` se stejným příkazem.
- **Psaní věty se nezrychluje.** Zrychlit smí jen montáž `more-sentences`, a pak s viditelným označením.

## Co se netočí, a proč

- **Žádné časy v titulku bez běhu, ze kterého pocházejí.** Veřejná čísla (čas do hry, čas AI verze) přijdou z jednoho běhu na finálním buildu (10. 11.); titulek „in N seconds“ až potom.
- **Žádná čísla o objemu práce** – ani v titulku, ani v záběru na terminál nebo git.
- **Žádný firemní branding, paleta ani font zaměstnavatele** (`RULES.md` §6). Barvy a písmo jsou z `docs/brand/`.
