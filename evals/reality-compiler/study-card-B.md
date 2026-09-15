# Karta B — archiv

Fiktivní prostorová procedura. Pracovník začíná vedle stanice A. Její první platná aktivace spustí 30sekundové okno. Aktivace B před koncem okna odemkne archiv a timer zastaví. Expirace má na stejném tiku přednost a spustí nevratné upozornění; archiv zůstane zamčený. A čas nerestartuje a B před A nemá účinek. Aktivace funguje jen ze sousední buňky, nikoli na dálku. Po úspěchu nebo upozornění se výsledek už nemění.

| Událost | Čas od aktivace A | Prostor |
|---|---:|---|
| Aktivace A | 0 s | pracovník sousedí s A |
| Chůze k B | po A | skutečný přesun do dosahu B |
| Aktivace B | 18 s | pracovník sousedí s B |
| Pozorování obou větví | 28 s | stejný záznam vstupů |

Změň pouze časové okno na **25 sekund**. Ukaž původní i změněný výsledek. Vysvětli, co pochází ze zdroje, co je experimentální změna a co je důsledek simulace. Pomohla ti některá prostorová informace? Která a jak?
