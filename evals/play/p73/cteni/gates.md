# P73B T3 – kudy vzniká hratelná hra a co ověřila brána

Stav kódu 6. 11. 2026 (větev `features/P73B-cteni-a-kontrola-2026-11-06`, základ `3a0cfb75`).

## Fakta: každá uložená verze prošla bránou

Do úložiště verzí zapisuje jediná funkce, `storePublished` (`src/app/api/play/_publish.ts`). Volají ji jen dvě
publikace a obě před zápisem hru odmítnou, když kontrola neprošla:

| Cesta | Kde | Brána |
|---|---|---|
| Návrh z věty (draft) | `games/route.ts:195` | `publishReadSpec` → `reportFor` → `publishEligible` |
| Hra rovnou od režiséra | `games/route.ts:208` | `publishReadSpec` |
| Hotový spec v POST | `games/route.ts:214` | `publishReadSpec` |
| AI verze (upgrade) | `_upgrade.ts:505` | `publishReadSpec` |
| Hra ze čtení (`relation: 'reading'`) | `_upgrade.ts:324` | `publishReadSpec` |
| Remix čipem / větou | `remix/route.ts:115`, `:151`, `_remix-jobs.ts:237` | `publishReadSpec` |
| Sdílená verze po živé změně | `live-share.ts` → `POST …/remix` → `remix/route.ts:151` | `publishReadSpec` |
| Řetěz mikroher | `games/route.ts:181` → `publishChain` | `verifyChain` (každé kolo `verifyArcade`, celý řetěz robotem); zpráva = zpráva kola 1 |
| Vestavěné hry | `src/play/version/builtin*.json` | zpráva brány uložená v JSON; `builtin.test.ts:47` drží `publishEligible === true` |

`reportFor` (`_report.ts`) posílá arkádu do `verifyArcade` + `arcadeReport` (kontroly `bot_wins`, `idle_loses`,
`replay_equal`, `within_limits`, případně `verbs_proved`, `logic_proved`) a mřížku do `verifyGame`
(`src/play/verify/index.ts`: keypointy specu, svědek robota, dvojí replay, rozpočty).

## Co řádek „Checked“ smí říct

`checkFacts` (`src/components/play/lab.ts`) čte uloženou zprávu brány, ne předpoklad. `publishEligible: false` nebo
robot bez výhry → `null`, řádek ani list nejsou.

| Hra | a robot beat it | doing nothing never wins | plays the same every time |
|---|---|---|---|
| Arkáda | `bot_wins` + `witness.certified` | `idle_loses` | `replay_equal` + `replayEqual` |
| Mřížka (`verifyGame`) | `witness.certified` | **brána nekontroluje → vynecháno** | `replayEqual` |
| Řetěz | řádek se neukazuje – `ChainPlay` kartu čtení nemá | – | – |

- Brána u nečinného hráče ověřuje, že **nevyhraje** (`idle.outcome === 'won'` je chyba), ne že prohraje – nečinný běh
  může doběhnout do stropu tiků. Proto „doing nothing never wins“, ne „doing nothing loses“.
- Hra, kterou prohrát nejde (`loseLineOf` → `null`), větu o nečinném hráči vynechá (AC T4).

## Cesty bez řádku

- **Běh se živou změnou.** `acceptLive` (`src/play/arcade/live.ts:298`) ověří jen to, že robot změněnou hru dál
  vyhraje – nečinného hráče ani přehrání ne. Karta startu se se změnami nikdy neukáže (restart změny zahodí,
  `session.patches()`); karta výsledku po běhu se změnou odkaz „Why this game is fair“ nedostane (T4).
- **Řetěz mikroher** (`ChainPlay`): kartu „How I read it“ ani „Checked“ nemá, AC T2 jmenuje jen arkádu a mřížku.
- **Feed** (`ReelFeed` → `ArcadePlay` bez `read`): bez karty čtení, tedy bez řádku.
