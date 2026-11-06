# P73A T6 – held-out sada P30, čtení a role

Rychlá verze bez robota a bez přiznání: `evals/play/p30/dev.json` (60) + `test-200.json` (200) = 260 vět, seed 1.
Měřidlo `holdout.measure.ts`, stejný soubor nad oběma stromy, 6. 11. 2026.

- **main** = základna větve `3a0cfb75` (`holdout-main.json`).
- **větev** = `a38276eb`, T1–T5 (`holdout-head.json`).

| Měřítko | main | větev |
|---|---|---|
| role z kontrolního seznamu, které drží svůj popisek | 194/326 | 194/326 |
| místo z věty v nastavení nebo sadě scény | 164/190 | 164/190 |
| hrdina kreslený svým modelem, ne modelem z nouze | 226/260 | 229/260 |
| arkádový svět se přeloží | 260/260 | 260/260 |

**Po větách:** horší 0. Lepší 3, všechny „hrdina modelem“:

- t101 „a unicorn gallops across rainbow clouds collecting stars“
- t169 „a jellyfish drifts upward avoiding fishing nets“
- t186 „a bat navigates a pitch black cave using echoes“

**Co měření nepokrývá:** výhru robota a text přiznání. Hratelnost hlídají cílené testy T1–T5, přiznání `honesty-witness`.
