# P16 – který model a úsilí jde do dema

Vítěz: astra-high (gpt-6-astra @ high) – rozhodnutí vlastníka 15. 9. 2026, ne pravidlo

**Slepé hodnocení (H1) se nekonalo.** Vlastník si prohlédl fotky všech variant s popisky a srovnání astra@medium proti astra@high věta po větě a vybral high: doručila 7 z 8 světů (medium 6 z 8) a na větách t1, t2 a c08 čitelněji trefila námět. Pravidlo zapsané předem (`pickWinner` ve `scripts/effort-sheet.mjs`) by nevybralo nikoho – každá varianta vypadla na selháních (víc než 1 z 8) nebo na p95 času nad 240 s.

**n = 8 vět, jeden hodnotitel, bez slepého hodnocení – není citovatelná míra.** Stačí na výběr modelu pro demo, ne na tvrzení v přihlášce.

**Riziko výběru:** 3 z 7 světů astry@high dorazily až po 300 s (305 s, 337 s, 353 s), a Vercel utíná funkci na 300 s. Lokální čas navíc nezahrnuje cestu přes tunel.

| Varianta | Model | Světů dorazilo | Medián času | p95 času | Světů přes 300 s | Pravidlo T4 |
|---|---|---|---|---|---|---|
| luna | gpt-5.6-luna | 6 z 8 | 39 s | 50 s | 0 | vypadla – 2 selhání |
| sol | gpt-5.6-sol | 6 z 8 | 104 s | 144 s | 0 | vypadla – 2 selhání |
| astra-low | gpt-6-astra@low | 8 z 8 | 142 s | 296 s | 0 | vypadla – p95 296 s |
| astra-medium | gpt-6-astra@medium | 6 z 8 | 133 s | 162 s | 0 | vypadla – 2 selhání |
| astra-high **(vybráno)** | gpt-6-astra@high | 7 z 8 | 258 s | 353 s | 3 | vypadla – p95 353 s |
| astra-xhigh | gpt-6-astra@xhigh | 3 z 7 (1 neměřeno) | 481 s | 634 s | 2 | vypadla – 4 selhání |
| astra-max | gpt-6-astra@max | 2 z 8 | 389 s | 625 s | 2 | vypadla – 6 selhání |

Čas = od odeslání věty po živý svět v prohlížeči, lokální `next start`. astra-xhigh:c17 zablokoval lokální strop útraty dřív, než se model zavolal; po výběru vlastníka se nedoměřoval.
