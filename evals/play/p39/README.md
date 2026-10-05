# P39 – věci z věty ve správné roli: měření

`baseline.json` = stav před přestavbou obsazení (kód `c9ce1daa`, žánry a režisér jako na `main` `88245889`),
`after.json` doplní T13 stejným postupem.

## Co čísla znamenají

- `read`, `drawn` – podíl položek kontrolního seznamu dev sady (`evals/play/p30/dev.json`, 60 vět), které hra čte a scéna nakreslí.
- `role` – podíl položek, které navíc hrají roli, kterou jim věta dává (`does` v dev sadě; stupeň `role` v `src/play/fidelity/chain.ts`).
- `roleNamed` – totéž jen nad věcmi s očekávanou rolí (78 položek); tam se role může minout.
- `offline` – rychlá verze bez sítě; `live.draft` – rychlá verze ze serveru; `live.final` – AI verze, když vyšla, jinak rychlá.
- `byGenre` – průměr podílů přes věty žánru (žánr podle `controlParams.generator`, jinak ovládání).

## Výchozí stav (5. 10. 2026)

| | read | drawn | role | roleNamed |
|---|---|---|---|---|
| offline (rychlá) | 0,759 | 0,727 | 0,691 | 0,453 |
| živě, výsledná verze (AI 56/60) | 0,782 | 0,741 | 0,709 | 0,387 |

AI verze dnes roli věcí z věty spíš kazí (`roleNamed` 0,453 → 0,387).

## Jak běh zopakovat

```
npm run build
set PLAY_DIRECTOR_CALLS_PER_CALLER=1000   # jinak po 12 voláních MODEL_UNAVAILABLE
set WORLDSMITH_CALL_CAP=1000
# + proměnné z .claude/start-demo.cmd (WORLDSMITH_MODEL_ENDPOINT=codex-cli …), předplatné, žádné placené API
node node_modules/next/dist/bin/next start -p 3100
node --experimental-strip-types scripts/play-fidelity.mjs run --base http://127.0.0.1:3100 --set dev --run <id> --gpu
node --experimental-strip-types scripts/play-fidelity.mjs roles --run <id> --set dev --out evals/play/p39/<baseline|after>.json
```

Běh posílá věty po jedné (~15–40 s na větu přes `codex-cli`); výsledky a snímky jsou v `evals/play/fidelity/runs/<id>/` (gitignorované).
