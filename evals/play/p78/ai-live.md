# P78 T4 – AI verze naživo (8. 11. 2026)

**Výsledek: AI verze na produkci nepřišla.** Server odpověděl `MODEL_UNAVAILABLE`: ve Vercelu chybí klíče režiséra. Podle plánu jsem nic dalšího nezkoušel – 20 vět, časy ani útrata se neměřily.

| | hodnota |
|---|---|
| kdy | 8. 11. 2026 08:58:34 UTC (09:58 SEČ) |
| kde | https://worldstream-sigma.vercel.app, strom `4e176d1f` (`/api/build-id`) |
| věta (nová, nikdy dřív neposlaná – paměť režiséra by jinak vrátila starou verzi) | „a lighthouse cat herds glowing jellyfish into a harbour before the tide turns“ |
| rychlá verze | 201, 6,4 s, verze `7507c0ab376258b55d5720e86a384c34` |
| AI verze (`GET /api/play/games/<id>/upgrade`) | `{"status":"draft-final","reason":"MODEL_UNAVAILABLE"}` po 9,5 s |
| útrata | 0 USD – model se nevolal |

Stejný stav jako 7. 11. (`evals/play/p74/ai.json`: 0/5, `MODEL_UNAVAILABLE`). AI verzi zapnou klíče režiséra v prostředí Vercelu a nové nasazení. Strop útraty 15 USD (finální nasazení s předponou `sayplay`) je v plánu hlavního sezení.
