# P83A T1 – proč počítadlo stálo na 0/3 a ukázalo „+1“

Měřeno 10. 11. 2026 na `origin/main` `113c4327`, rychlá verze (bez modelu), semínko jako `POST /api/play/games`.
Skript: `evals/play/p83/a-repro.ts` (jádro), `evals/play/p83/a-shots.ts` (prohlížeč, `next start` :3211, d3d11).
Snímky: `D:/tmp/p83a/before-*.png`.

## Výsledek

| Věta | Robot vyhraje | Začátečník vyhraje do 60 s (10 seedů) | Náhodný hráč ≥ 1 věc za 60 s (10 seedů) | „+1“ bez růstu počítadla |
|---|---|---|---|---|
| rytíř a tři zlaté klíče | 42,4 s | 3/10 | 2/10 | 12 ze 14 |
| obchod, tři věci na pult | 42,3 s | 1/10 | 1/10 | 6 z 8 |

Jádro počítá správně: každý sebraný klíč zvedne `items` i skóre a třetí vyhraje. Vada je ve dvou věcech kolem.

## Příčina 1 – „+1“ ukazuje i věc, která se nepočítá

- Sběrnice efektů dělá vizuální `pickup` z každého zmizení těla role `collectible` – `src/components/play/arcade/effects/bus.ts:149`. Nad každým `pickup` se kreslí „+1“ – `src/components/play/arcade/effects/feel.ts:102`, `src/components/play/arcade/effects/Effects.tsx:195`.
- Role `collectible` má ale i **jiskra tepu pole** (`HEARTBEAT_SPARK`, `src/play/arcade/pieces/pacing-parts.ts:457`). Ta se do cíle nepočítá – `src/play/arcade/pieces/waves.ts:252` („bonus pro člověka – sběr ji nepočítá do skóre ani vlny“), `arena_eat` ji jen odebere – `src/play/arcade/pieces/arena.ts:504`.
- Tep přidá jiskru po 2,5 s bez události na nejbližším místě vstupu u hráče a se třemi jiskrami odvolá tu nejvzdálenější – `src/play/arcade/pieces/pacing.ts:438`. Sebraná i odvolaná jiskra = „+1“ nad scénou, počítadlo stojí.
- Na snímku `before-knight-pop-at-zero.png` visí „+1“ u okraje arény při „keys 0/3“; `before-shop-pop-at-zero.png` totéž u obchodu po 3,9 s.

Takže „+1“ nebyla jiná měna ani vlna: je to jiskra, kterou hráč (nebo tep) sebral, a ta se do klíčů nepočítá.

## Příčina 2 – klíčů je na hřišti málo a jsou malé

- Věta s počtem dává věci po vlnách na čas: na startu 1 klíč, druhý nejdřív ve 14,5 s, třetí nejdřív ve 29 s – `src/play/arcade/pieces/waves.ts:137` (`COUNTED_PLAN`), `waves.ts:140` (`countedTicks`), zapojené v `src/play/arcade/pieces/arena.ts:968` (útěk, rytíř) a `arena.ts:1073` (sběr, obchod). Rychleji než za ~30 s tedy nevyhraje nikdo a robot potřebuje 42 s.
- Klíč je tělo 0,5 m a kreslí se 0,7 m (`ITEM_DRAWN_M`, `src/components/play/arcade/arena/ArenaScene.tsx:315`) v aréně 40 × 40 m. U rytíře se kreslí model `key`, u obchodu („items“) model není a kreslí se drahokam. Jiskry (bílé zářící hvězdy, `before-knight-pop-at-zero.png`) jsou vidět víc než klíč.
- Mezitím od ~30 s přicházejí strážce, přepadávač a boss (rozvrh `pacing` podle uběhlého času) a začátečník přijde o životy v 34–50 s, dřív, než doběhne pro třetí klíč.

Skriptovaný hráč soudu tedy za 55 s neměl co sebrat: jeden malý klíč někde v aréně, kolem něj jiskry, které „+1“ dají, ale počítadlo ne.

## Co z toho plyne pro T2

1. „+1“ jen tam, kde roste cíl (oprava ve sběrnici, ne v HUD).
2. Věc věty dřív a víc na dohled (méně čekání na vlny) a čitelnější než jiskra.
3. Měřit znovu stejnými skripty: začátečník obou vět do 60 s, náhodný hráč ≥ 1/3 u 8 z 10 seedů.
