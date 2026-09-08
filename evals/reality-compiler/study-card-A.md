# Karta A — muzeum

Fiktivní prostorová procedura. Návštěvník začíná vedle stanice A. Její první platná aktivace spustí 20sekundové okno. Aktivace B před koncem okna odemkne vitrínu a timer zastaví. Expirace má na stejném tiku přednost a spustí nevratný alarm; vitrína zůstane zamčená. A čas nerestartuje a B před A nemá účinek. Aktivace funguje jen ze sousední buňky, nikoli na dálku. Po úspěchu nebo alarmu se výsledek už nemění.

| Událost | Čas od aktivace A | Prostor |
|---|---:|---|
| Aktivace A | 0 s | návštěvník sousedí s A |
| Chůze k B | po A | skutečný přesun do dosahu B |
| Aktivace B | 12 s | návštěvník sousedí s B |
| Pozorování obou větví | 15 s | stejný záznam vstupů |

Změň pouze časové okno na **10 sekund**. Ukaž původní i změněný výsledek. Vysvětli, co pochází ze zdroje, co je experimentální změna a co je důsledek simulace. Pomohla ti některá prostorová informace? Která a jak?
