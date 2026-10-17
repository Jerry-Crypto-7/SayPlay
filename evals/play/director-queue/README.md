# P53 – fronta režiséra

Na jedné instanci smí běžet jen `PLAY_DIRECTOR_SLOTS` režií `/play` naráz (výchozí 2); další věty čekají ve frontě místo okamžitého `MODEL_UNAVAILABLE`.

## Rozhodnutí bez majitele

- **T1:** `PLAY_DIRECTOR_SLOTS` je omezená shora invariantem rezervy (`MAX_PLAY_DIRECTOR_SLOTS` v `src/server/paid-slots.ts`, dnes 2), ne zvednutím `MAX_CONCURRENT_GENERATIONS` o rozdíl – proměnná tak zatím strop jen snižuje (1 pro e2e) a víc placených volání v letu nepustí.
