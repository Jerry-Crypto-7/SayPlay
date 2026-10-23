# P56C T19 – kolo 1 řetězu

Generuje `round1.measure.ts` (popis v hlavičce). Podíl = nejčastější první mikrohra / řetězy sady.

| Sada | before: nejčastější kolo 1 | after: nejčastější kolo 1 | before: verifyChain | after: verifyChain |
|---|---|---|---|---|
| chain (10) | runner.default 40 % | catch.default 40 % | 10/10 | 10/10 |
| chain4 (40) | – | platformer.default 25 % | – | 40/40 |
| dev (40) | runner.default 23 % | catch.default 23 % | 40/40 | 40/40 |
| read (150) | catch.default 21 % | timing.stack 16 % | 150/150 | 150/150 |

## before

- chain: runner.default 4, catch.default 2, platformer.default 2, whack.default 1, shooter.default 1
- dev: runner.default 9, catch.default 8, whack.default 6, platformer.default 4, timing.stack 3, shooter.default 3, flap.default 2, hop.default 2, defense.default 1, crowd.default 1, duel.default 1
- read: catch.default 32, timing.precision 29, runner.default 23, duel.default 16, shooter.default 14, hop.default 14, timing.stack 5, whack.default 5, platformer.default 5, rhythm.default 4, flap.default 2, defense.default 1
- telefon hedgehog: whack.default → timing.stack → runner.default → crowd.default → shooter.default.boss
- telefon lighthouse: whack.default → timing.stack → rhythm.default → crowd.default → duel.default.boss

## after

- chain: catch.default 4, platformer.default 2, crowd.default 1, hop.default 1, shooter.default 1, runner.default 1
- chain4: platformer.default 10, catch.default 9, runner.default 8, crowd.default 3, hop.default 3, shooter.default 3, rhythm.default 3, whack.default 1
- dev: catch.default 9, crowd.default 4, defense.default 4, platformer.default 4, hop.default 4, shooter.default 4, runner.default 3, timing.stack 3, flap.default 2, whack.default 2, duel.default 1
- read: timing.stack 24, platformer.default 20, catch.default 20, whack.default 18, runner.default 18, timing.precision 15, hop.default 8, duel.default 8, shooter.default 7, rhythm.default 4, crowd.default 3, defense.default 3, flap.default 2
- telefon hedgehog: timing.stack → runner.default → duel.default → flap.default → defense.default.boss
- telefon lighthouse: rhythm.default → timing.stack → whack.default → crowd.default → duel.default.boss
