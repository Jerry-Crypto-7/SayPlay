# P53 – fronta režiséra

Na jedné instanci smí běžet jen `PLAY_DIRECTOR_SLOTS` režií `/play` naráz (výchozí 2); další věty čekají ve frontě místo okamžitého `MODEL_UNAVAILABLE`.

## Rozhodnutí bez majitele

- **T1:** `PLAY_DIRECTOR_SLOTS` je omezená shora invariantem rezervy (`MAX_PLAY_DIRECTOR_SLOTS` v `src/server/paid-slots.ts`, dnes 2), ne zvednutím `MAX_CONCURRENT_GENERATIONS` o rozdíl – proměnná tak zatím strop jen snižuje (1 pro e2e) a víc placených volání v letu nepustí.
- **T2:** termín fronty je rozpočet trasy minus `minCallMs()` primáru (astra `MIN_CALL_MS` 75 s, gpt-oss 30 s), ne pevně `MIN_CALL_MS` – s pevnými 75 s by fronta odmítla gpt-oss se 40 s zbytku i při volném slotu, což dnes odejde.
- **T2:** na slot se čeká až u prvního volání modelu, ne před režií – věta z cache model nevolá, takže za dvěma pomalými větami nečeká.
- **T3:** text ve frontě drží větu kitu místo příkladu z plánu („Busy right now – …“), protože `11-voice-copy.md` má „The AI is busy right now“ ve sloupci *Not*: pilulka čte „Quick version · the full-detail one is next in line“ (od druhého místa „… is #3 in line“), viditelně krátce „Next in line“ / „#3 in line“; remix „Your change is next in line – the original stays as it is.“ Pořadí nese `queued` ve stavu `pending` (upgrade i remix), 1 = další na řadě; po získání slotu z odpovědi zmizí.
