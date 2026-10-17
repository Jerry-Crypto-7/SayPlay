# P53 – fronta režiséra

Na jedné instanci smí běžet jen `PLAY_DIRECTOR_SLOTS` režií `/play` naráz (výchozí 2); další věty čekají ve frontě místo okamžitého `MODEL_UNAVAILABLE`.

## Zátěžová zkouška (T4)

`npm run build`, pak `node scripts/load/director-burst.mjs --players 8 --slots 2` (exit 0 = obě podmínky drží). Skript pustí náhradní upstream na `127.0.0.1` s nahranými odpověďmi `src/play/director/__fixtures__/p46-answers` (v P46E 25/25 AI verzí; `evals/play/p30/dev.json` nahrané odpovědi nemá), 3 s na volání, a nad ním `next start` na portu 3312 s prostředím bez skutečného modelu a sdíleného úložiště. Dva běhy do `report.json`:

- **burst** (fronta výchozí): 17. 10. 8/8 AI verzí, 0× `MODEL_UNAVAILABLE`, souběh na upstreamu 2/2, čekání na první volání medián 21,9 s, max. 39,1 s (36 volání: opravná kola a pokyn `ADD_NUDGE` jdou frontou znovu).
- **overflow** (`PLAY_DIRECTOR_QUEUE=2`): 4 AI verze, 4× `MODEL_UNAVAILABLE`; sonda `time-to-playable` na odmítnuté hře: rychlá verze hratelná.

Krátká verze v `e2e/p53-director-queue.spec.ts` (4 hráči, strop 1, ~1,2 min; postaví si vlastní server na 3313). Zkouška nastavuje `VERCEL_ENV=preview` bez `VERCEL` (jinak kniha útraty mimo Vercel chybí a strop odmítne každé volání) a `PLAY_DIRECTOR_CALLS_PER_CALLER=1000` (všichni hráči jsou tu jeden volající `untrusted`).

**Na Vercelu:** `PLAY_DIRECTOR_SLOTS` (1–2, výchozí 2) a `PLAY_DIRECTOR_QUEUE` (0 = fronta vypnutá, výchozí 16) v Project → Settings → Environment Variables pro Production i Preview; po změně redeploy. Bez nich platí výchozí hodnoty. Fronta je v paměti instance – víc instancí = víc front (Co nevíme v plánu P53).

## Rozhodnutí bez majitele

- **T1:** `PLAY_DIRECTOR_SLOTS` je omezená shora invariantem rezervy (`MAX_PLAY_DIRECTOR_SLOTS` v `src/server/paid-slots.ts`, dnes 2), ne zvednutím `MAX_CONCURRENT_GENERATIONS` o rozdíl – proměnná tak zatím strop jen snižuje (1 pro e2e) a víc placených volání v letu nepustí.
- **T2:** termín fronty je rozpočet trasy minus `minCallMs()` primáru (astra `MIN_CALL_MS` 75 s, gpt-oss 30 s), ne pevně `MIN_CALL_MS` – s pevnými 75 s by fronta odmítla gpt-oss se 40 s zbytku i při volném slotu, což dnes odejde.
- **T2:** na slot se čeká až u prvního volání modelu, ne před režií – věta z cache model nevolá, takže za dvěma pomalými větami nečeká.
- **T3:** text ve frontě drží větu kitu místo příkladu z plánu („Busy right now – …“), protože `11-voice-copy.md` má „The AI is busy right now“ ve sloupci *Not*: pilulka čte „Quick version · the full-detail one is next in line“ (od druhého místa „… is #3 in line“), viditelně krátce „Next in line“ / „#3 in line“; remix „Your change is next in line – the original stays as it is.“ Pořadí nese `queued` ve stavu `pending` (upgrade i remix), 1 = další na řadě; po získání slotu z odpovědi zmizí.
- **T5:** `e2e/play-share.spec.ts` („the link stops working when it restarts“) počítá s úložištěm her v paměti, ale každý zapisovatelný `PLAY_STORE_DIR` – i ten, který nastavuje `webServer` v `playwright.config.ts` – dá souborové úložiště a hlavičku `x-play-store: file`, takže test padá i bez P53 (sdílení ani úložiště P53 nemění). Regrese P53 se proto certifikovala na serveru s nezapisovatelným `PLAY_STORE_DIR` (cesta pod souborem → úložiště v paměti): 12/12; srovnat spec s P40 souborovým úložištěm je samostatná oprava mimo P53.
