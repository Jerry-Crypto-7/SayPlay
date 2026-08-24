# Scénář dema — 2:44 ze 3:00

Tvrdý limit je **3:00** (`RULES.md` §2). Tenhle scénář má **2:44**, takže na střih
zbývá šestnáct sekund. Stopáž hlídá `node scripts/video-check.mjs docs/video-script.md`
— sečte úseky, ověří, že na sebe navazují, a odmítne scénář, kterému chybí beat.

**Bez obličeje a bez rozpoznatelného hlasu** (`RULES.md` §5). Proto **titulky, žádná
narace**. Titulky jsou anglicky, protože je čte porotce; tenhle dokument je česky,
protože ho čte ten, kdo točí.

---

## Časová osa

| Čas | Beat | Co je na obrazovce | Titulek |
|---|---|---|---|
| 0:00–0:12 | `opening` | Prázdné plátno, uprostřed nápověda „Napiš větu. Postaví se z ní svět, který se dá hrát.", nahoře pole. Kurzor píše větu, kterou systém nikdy neviděl. | `A sentence goes in. Not a prompt for a model — an input to a compiler.` |
| 0:12–0:40 | `world-builds` | Tlačítko „Postav svět" → „Pracuju…", stavy „odesláno / generuje se / staví se". Svět se odkrývá po kusech. Pak najetí na panel vlevo dole „Co model napsal" — sekce „Tvar stavby", „Pravidla", „Cíl". | `The model writes no code. It emits two declarative branches: a geometry program and a rule graph. Both are on screen, readable.` |
| 0:40–1:00 | `playable` | Hra: číslicemi chůze k cílům, mezerníkem sběr. Postava se hýbe, počítadlo cíle se mění. | `Hand-written deterministic interpreter runs it. Twenty ticks a second, no wall clock anywhere in the hashed state.` |
| 1:00–1:32 | `winning-path` | Panel vpravo dole „Jak to systém vyhrál". Postupuje počítadlo „3 / 5 · výhra v tiku 240", řádky kroků typu „2. tik 60 — player: pickup → key1". Na konci tlačítko „Přehrát znovu". | `Nobody scripted this route. The verifier searched for it, certified it, and the replay's hash equals the certificate's.` |
| 1:32–2:10 | `rule-rewind` | Panel vlevo dole „Čas". Táhlo „Přetočit čas" jede zpět, počítadlo „tik N / 200" klesá. Klik na „Vypnout jedno pravidlo a přepočítat budoucnost". Objeví se věta „Bez pravidla … Budoucnost se přepočítala." a druhý hash „· původní …". | `Rewind, switch one rule off, and the future is recomputed from that tick. Two state hashes, side by side: the old one and the one that exists now.` |
| 2:10–2:34 | `offline` | Otevřený Network panel v prohlížeči. Druhá neviděná věta. `/api/generate` vrátí **404** — a svět se přesto postaví. V seznamu požadavků není jediný bajt modelových vah. | `The server has no answer for this sentence and says so. The world is built here, in the browser. No weights downloaded, no model call, nothing to be offline from.` |
| 2:34–2:44 | `close` | Veřejná adresa dema na plátně, pod ní postavený svět z posledního beatu. | `Type your own sentence.` |

**Součet 2:44.** Sedm úseků, čtyři povinné beaty (`world-builds`, `rule-rewind`,
`offline`, `winning-path`) plus tři přechodové.

---

## Věty, které se do kamery píšou

Obě jsou **mimo** ukázky, které nabízí prázdná obrazovka, a mimo text v poli. To je
schválně: `RULES.md` §3.3 říká, že porotce zkouší vlastní prompty, takže demo, které
předvádí své vlastní ukázky, nedokazuje nic.

1. Beat `world-builds`: `a stealth level where guards patrol and see me if I stand in the light`
2. Beat `offline`: libovolná věta, kterou píšeš až u kamery — čím míň připravená, tím
   líp. Nemusí být rozpoznaná; když nebude, postaví se náhradní místnost a nad polem
   se objeví věta, která to přizná. **To je taky dobrý záběr**, ne vada — jen se u něj
   titulek změní na `Even a sentence it cannot read yields a playable room, and says so.`

---

## Co se netočí, a proč

- **Nevytahuj kabel a nezapínej v DevTools „Offline".** Zní to jako nejsilnější důkaz
  a **není pravda, že to funguje**: požadavek pak spadne s výjimkou a nad polem se
  objeví „Požadavek se nepodařilo odeslat." — žádný nový svět. Lokální stavba se dnes
  spustí jen tehdy, když **server odpoví** 404. Tenhle rozdíl je zapsaný v plánu jako
  úloha; dokud se neuzavře, beat `offline` se točí přes 404, ne přes odpojení.
- **U beatu `rule-rewind` drž záběr na panelu, ne na 3D scéně.** Panel času si počítá
  vlastní simulaci vedle plátna, takže se po přepočtu **nepřeanimuje svět** — změní se
  počítadlo tiku, přibude druhý hash a napíše se výsledková věta. Záběr na plátno by
  ukazoval, že se nestalo nic.
- **Nezmiňuj rychlost lokálního modelu.** Naměřený medián je desítky sekund a
  `schemaValid` 0 ze 40; model proto v produktu není zapojený a číslo by mluvilo o
  větvi, kterou nikdo nevidí.
- **Žádný firemní branding, paleta ani font zaměstnavatele** (`RULES.md` §5).

---

## Čísla, která se smí objevit v titulku

Každé je naměřené v repozitáři, ne odhad.

| Číslo | Kde je naměřené |
|---|---|
| pole je použitelné do 3 s od načtení | `e2e/first-click.spec.ts` — běh vypíše skutečnou hodnotu |
| svět se skládá 800 ms (16 tiků při 20 Hz) | `src/components/viewer/Assembly.tsx` |
| 70 nepřátelských vět → 70 hratelných světů, 0 prázdných scén | `evals/hostile-report.json` |
| nejpomalejší z těch 70 vět: 19,76 ms | `evals/hostile-report.json` |
| horizont přetáčení 200 tiků | `src/components/pipeline/Timeline.tsx` |

**Nepoužívej „svět se postaví do dvou sekund".** Je to cíl ze specifikace, ne číslo
naměřené od věty k hotovému snímku. Obhajitelné znění je to v tabulce výš.
