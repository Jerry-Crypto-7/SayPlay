# P20 T17: navržený host a rozpočet, 17. 9. 2026

**Připravený kandidát, nic objednáno ani nasazeno:** jedna Hetzner Cloud CPX42 v Německu, Ubuntu 24.04 x86-64, jeden Next proces a omezené Astra CLI subprocessy. 16 GB RAM ponechává rezervu nad `MemoryMax=8G` služby. Build vznikne před startem, žádné paralelní repliky. Volba je technický návrh k pozdější autorizaci; dostupnost instance ani hosted CLI/sandbox nejsou ověřené.

CPX42 má 8 vCPU, 16 GB RAM a 320 GB disk podle [specifikace poskytovatele](https://www.hetzner.com/European-cloud/). Cena pro nové EU objednávky je **0,1114 EUR/h, měsíční strop 69,49 EUR bez IPv4 a DPH**, podle [ceníku účinného od 15. 6. 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/). Veřejné stránky ověřeny 17. 9.; před nákupem znovu ověřit závaznou nabídku.

| Položka | 72 hodin demonstrace | Celý měsíc |
|---|---:|---:|
| VM, pokud na konci období skutečně zrušena | 8,0208 EUR | nejvýše 69,49 EUR |
| IPv4 a případné zálohy | rezerva 5 EUR, nikoli nabídka | rezerva 10 EUR, nikoli nabídka |
| REST spend ledger: modelový objem 100 000 / 1 000 000 příkazů | 0,20 USD | 2,00 USD |
| Bezpečnostní rezerva ledgeru | schvalovací strop 5 USD | schvalovací strop 5 USD |

Ledger kandidát je jedna Upstash Redis Pay-as-you-go databáze v EU bez dalších read regions: [ceník](https://upstash.com/pricing/redis) uvádí 0,20 USD/100 000 příkazů, první 1 GB dat a 200 GB měsíčního přenosu zdarma. Výpočet předpokládá objemy pod těmito mezemi; nejsou změřeným provozem aplikace. Nastavený rozpočtový limit při vyčerpání omezuje provoz a produkt musí selhat bezpečně. Nový účet ani dočasná databáze nebyly založeny.

**Navržená obálka infrastruktury:** 14 EUR + 5 USD / 72 h nebo 80 EUR + 5 USD / měsíc, vždy před daní, bez inference, domény a práce operátora. Měny se nesčítají bez aktuálního kurzu. Jde o zaokrouhlený plánovací strop, nikoli garantovaný účet. Hosted oprávnění Astry/předplatného a případné poplatky nejsou známé; účetní tokenové sazby lokálních měření nejsou ceník inference. Nové 3D assety mají oddělený dosud neschválený rozpočet.

## Připravená konfigurace a chybějící vstup

Použít zdejší `worldstream.service`, `host.env.example`, `preflight.mjs` a watchdog jednotky. Ordinary sessions: service-owned `/var/lib/worldstream/ordinary-sessions.json`; lokální single-writer store, žádný NFS ani další instance. Spend ledger zůstává mimo proces. Asset-job adapter je připravený, ale veřejná provider cesta není aktivovaná. Veřejné soubory mají hash cache a jsou součástí stejného buildu.

Operátor musí dodat autorizovaný host/účet, potvrdit oprávnění inference a Linux sandbox pod service userem, zajistit důvěryhodnou autentizační proxy s TLS a nebufferovaným SSE, přidělit doménu a ověřit restart/reconnect/3 návštěvníky na skutečném hostu. Oprávnění ani credentials se nepřenášejí z tohoto Windows stroje. Lokální restartový důkaz je v `plans/P20/session-restart-20260917/README.md`; nenahrazuje veřejný smoke, Linux power-loss test nebo monitoring. T17 zůstává PARTIAL / NOT_DEPLOYED.
