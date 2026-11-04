# P70B T4 – AI verze v lokálním demu (4. 11. 2026)

Režisér přes codex-cli na předplatném (`gpt-6-astra`, úsilí `medium`, profil `.claude/start-demo.cmd`), `next start` na :3202.

## Příčina (AC1)

Naměřeno skriptem, který pošle codexu přesně požadavek režiséra (kompaktní zadání + FULL INTENT):

| schéma odpovědi | výsledek | výstupní tokeny (z toho uvažování) | vstupní tokeny |
|---|---|---|---|
| plné, jak šlo (3 181 hodnot výčtů) | 4/4 „max_output_tokens“ → 5× znovu → HTTPS „Bad Request“, ~35 s | – | – |
| bez schématu | odpověď | 585 (268) | 18 910 |
| jen varianta receptu | odpověď | 715 (289) | 22 050 |
| `openaiStrictSchema` (opakované výčty v `$defs`) | odpověď | 621 (278) | 65 916 |

Odpověď sama je krátká. „max_output_tokens“ je způsob, jakým backend codexu odmítne schéma nad limitem 1 000 hodnot
výčtů – stejný limit, kvůli kterému cesta přes OpenAI API od P58B T7 schéma sdílí. Oprava: codex-cli dostává
`openaiStrictSchema` (`src/server/upstream.ts`, test v `upstream.test.ts` §7).

## Naživo (AC3)

| věta | výsledek | AI verze za | volání režiséra |
|---|---|---|---|
| a golfer putts the ball into the hole on a windy course | minigolf, Full detail přepne (`golf-*.png`) | ~207 s | 5 (3 + druhý běh s pokynem 2) |
| a race car speeds around the track dodging oil spills | závod, novinky boss + úseky (`race-car-*.png`) | 115 s | 3 (35 s, 20 s, 20 s) |
| a ninja slices fruit flying across the screen | krájení, novinka akce (`ninja-*.png`, `ninja-at-120s.png`) | ~125 s | 4 (52 s, 12 s, 41 s, 10 s) |
| a rabbit hops … / a knight fights … / a bee collects … | hra-řetěz, AI verzi z návrhu nemá (P58E) | – | 0 |

- AI verze dorazila **3 ze 3** vět, které šly k režisérovi (předtím 0 z 6 volání). Tlačítko Full detail ji přepnulo u všech tří.
- **Do 120 s jen 1 ze 3.** Čas nedělá délka odpovědi, ale počet volání za sebou: první volání 35–52 s (66 tis. vstupních
  tokenů, z toho ~47 tis. schéma), opravné kolo 10–20 s, a když AI verze nic nepřidá, celý druhý běh s pokynem.
- Čtvrtá věta k režisérovi neproběhla: plán dovoluje v T4 nejvýš 20 volání a 18 padlo na diagnózu (6) a tyto běhy (12).

Surová data: `live-race-car.json`, `live-ninja.json` (výstup `live.mjs`); golf a řetězy z prvního běhu jsou v tabulce výš.
