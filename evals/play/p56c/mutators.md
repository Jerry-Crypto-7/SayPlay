# P56C T16 – slepý soud: řetěz s mutátory proti řetězu bez nich

Změřeno 2026-10-21 na pracovním stromu nad `3b777b62` (kód T16 se zapnutými mutátory, commit T16 je pak vypnul) `judge-mutators.mjs`: 12 dev vět (první čtyři z rodin `multi_verb`, `no_verb`, `world_only`, které route posílá do řetězu), obě strany ze stejného buildu, druhý server s `PLAY_CHAIN_MUTATORS=0`. Stejné semínko = stejná kola i rozložení, liší se jen mutátory kol 2 až N−1. Klip 8 snímků jen plátna přes všechna kola, robot kola; soudce Codex nad listem v prázdném adresáři, strana vlevo losem (`JUDGE_SEED` 56014). Otázka stejná jako T14.

| Kontrola | Cíl | Výsledek |
|---|---|---|
| řetěz s mutátory vyhraje z rozhodnutých párů | ≥ 0.6 | 0/0 = null (nesplněno) |
| remízy | – | 12 |
| podíl výher levého sloupce (zkreslení soudce) | ~0,5 | null |

## Páry

| id | kola s mutátory | vlevo | vítěz | proč (soudce) |
|---|---|---|---|---|
| d01 | runner.default → hop.default + tiny_hero → crowd.default + mirror → timing.precision + vanishing_floor → defense.default.boss | mutators | tie | Both show the same variety: a snowy course, roads with rolling obstacles, multiplier gates, an icy arena, and a lane-based target game. A has a larger igloo in the opening scene, but neither shows clearly more varied or more inviting gameplay. |
| d02 | catch.default → runner.default + shield_start → flap.default + shield_start → rhythm.default + mirror → duel.default.boss | mutators | tie | Both show the same variety: a platform-and-target scene, an animal running down a wooded road, colored lanes with obstacles, and an animal fight. Neither shows a clear advantage in visual variety or reasons to keep playing. |
| d04 | platformer.default → timing.stack + shield_start → defense.default + extra_foes → duel.default + vanishing_floor → shooter.default.boss | plain | tie | Both games show the same variety: volcanic platforms, a green obstacle, a suspended bridge, a robot beside a boulder, and laser aiming across a canyon. Their later scenes are nearly identical, so neither offers a clear advantage in variety or appeal. |
| d05 | catch.default → platformer.default + tiny_hero → duel.default + giant_foes → rhythm.default + vanishing_floor → shooter.default.boss | mutators | tie | Both show the same variety: hoop challenges, platform jumps, balancing a ball on an orange pillar, colored lanes, and aiming at distant targets. B has slightly closer framing in places, but neither shows clearly more games or more appealing play. |
| d23 | timing.stack → runner.default + one_hit → whack.default + tiny_hero → platformer.default + shield_start → shooter.default.boss | plain | tie | Both show the same variety: a block obstacle, a bat flying down a road, mallets over holes, cliff platforms, and aiming at distant targets. Their scenery and action look equally appealing, with only small differences in positions and wing poses. |
| d24 | defense.default → flap.default + rush → rhythm.default + mirror → runner.default + one_hit → shooter.default.boss | mutators | tie | Both show the same variety: a lane-and-ball setup, green obstacle course, colored track, road ride, and open-field target aiming. Their scenery and progression are nearly identical, so neither looks more varied or more compelling to keep playing. |
| d25 | catch.default → timing.stack + vanishing_floor → duel.default + giant_foes → runner.default + mirror → shooter.default.boss | mutators | tie | Both show the same variety: a platform area, a tornado near a windmill, a tall target with a health bar, a forest path, and open-field shooting. B has slightly closer target framing, but neither shows clearly more varied or more engaging play. |
| d26 | catch.default → timing.stack + hero_grows → flap.default + rush → runner.default + one_hit → duel.default.boss | mutators | tie | Both show the same variety: a platform beneath an overhead block, a wooden tower near windmills, a green obstacle course, a forest run, and encounters with colorful figures. B has a denser obstacle layout, but neither visibly offers more different games or a clear reason to keep playing longer. |
| d33 | flap.default → catch.default + hero_grows → rhythm.default + tiny_hero → timing.stack + shield_start → shooter.default.boss | plain | tie | Both show underwater obstacle navigation, a ball-and-hoop scene, a lane with a paddle, stacked platforms, and laser aiming and firing. A has a wider paddle and B has a slightly different platform arrangement, but neither shows more game variety or a clear reason to keep playing longer. |
| d34 | catch.default → runner.default + shield_start → duel.default + vanishing_floor → hop.default + tiny_hero → shooter.default.boss | plain | tie | Both show the same variety: a furniture-lined running course, a giant cat encounter, busy traffic crossings, and aiming around a foggy arena. A has more orange traffic markers and a different opening object, but neither looks clearly more varied or more engaging. |
| d35 | timing.stack → runner.default + hero_grows → duel.default + shield_start → platformer.default + double_speed → defense.default.boss | plain | tie | Both show the same variety: a fox running along a road, striking a training dummy, crossing rocky platforms, and playing a lane-based musical game. The small framing and position differences give neither a clear edge in variety or appeal. |
| d36 | runner.default → crowd.default + giant_foes → shooter.default + vanishing_floor → duel.default + tiny_hero → defense.default.boss | plain | tie | Both show the same variety: street running, numbered gates, aiming across a plaza, an orange training target, and a green lane game. A’s character appears larger in the target scenes, but neither shows clearly more games or more compelling play. |

## Rozhodnutí

**`CHAIN_MUTATORS = false`** (`src/play/chain/contract.ts`). Brána AC je ≥ 0,60 výher z rozhodnutých párů; soudce nerozhodl ani jeden pár, takže splněná není. Mutátory zůstávají v kódu a v testech (`build.test.ts` je staví se zapnutým přepínačem), řetěz v produktu je beze změny proti T14.

Co soud říká (fakt): ve 12 z 12 párů soudce popsal obě strany jako „stejnou pestrost, téměř totožné“; jediné rozdíly, které zmínil, jsou velikost hrdiny nebo pádla (d33, d36: `hero_grows`, `tiny_hero`) a hustota překážek (d26) – a ani ty nerozhodly.

Proč asi (odhad, neměřeno):

- Většinu mutátorů na osmi statických snímcích vidět nejde: zrcadlové ovládání, štít navíc, nepřítel na jednu ránu, kratší hodiny a dvojí rychlost jsou změny pocitu ze hry, ne obrazu. Velikost hrdiny a nepřátel vidět jde, ale ve snímku z dálky je to pár pixelů.
- Kola i rozložení jsou na obou stranách stejné (mutátory se losují až nad hotovými koly), takže pestrost, na kterou se otázka T14 ptá, je u obou stran totožná – přesně proto soud rozlišuje jen mutátory, a ty na snímcích nevystoupí.

Co platí bez ohledu na soud (měřeno 21. 10., zapnuté mutátory):

- `dev.measure.ts`: `verifyChain` 40/40 (120/120 se dvěma dalšími semínky), ≥ 3 ovládání 40/40, mutátor nese 360/360 kol 2 až N−1 (`dev-result.md`).
- `e2e/play-chain.spec.ts` nad `next start`: chromium 2/2 (první kolo 1142 a 1022 ms; první běh na studeném serveru 1619 ms nad limitem 1500 ms), pixel7-touch 1/1; karta kola 2 ukázala „Tiny hero!“ pod slovesem.
- Stavba řetězu s mutátory a bez nich, prokládaně A, B, A, B na 20 dev větách: medián 285 / 273 / 283 / 346 ms – v šumu.

Co by rozhodlo jinak: soud nad klipem s pohybem (video nebo hustší snímky jednoho kola) místo osmi snímků přes celý řetěz, mutátory, které jsou vidět (tma kolem hrdiny `spotlight` – dnes ji nikdo nekreslí, proto ji stavitel vynechává), nebo dojem člověka na telefonu (HALT na konci plánu). Zapnutí = `CHAIN_MUTATORS = true` a nový build; `judge-mutators.mjs` pak soud zopakuje.

