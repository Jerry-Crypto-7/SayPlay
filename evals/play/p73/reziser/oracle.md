# P73C T5 – oracle v prohlížeči: kroky režie a čas k AI verzi

**Kdy:** 2026-11-06 odpoledne, `next start -p 3203` z této větve (po T2, `45415171`).
**Režisér:** codex-cli na předplatném (prostředí `.claude/start-demo.cmd`, `VERCEL_ENV=production`, `WORLDSMITH_FALLBACK_SPEND_CAP_USD=0`). Groq neměřen – klíč v prostředí není (stejně jako T1).
**Jak:** `node scripts/play/p73-oracle.mjs --base http://127.0.0.1:3203 --out evals/play/p73/reziser/oracle` – Chromium 1280×800 (d3d11, OpenXR vypnutý), tři věty, které server nikdy neviděl (0 zásahů cache, 3 volání režiséra na větu podle logu serveru). Čas = od otevření stránky rychlé verze po rozsvícení „Full detail“.

## Výsledek

| Věta | „Hero:“ vidět | první „Checking…“ | opravná kola | AI verze hotová |
|---|---|---|---|---|
| a hedgehog rolls down a mossy hill dodging falling pinecones | 36,9 s | 42,8 s | 2 | **70,4 s** |
| an otter paddles a leaf boat along a rainy canal and avoids grumpy frogs | 36,3 s | 42,4 s | 2 | **67,7 s** |
| a lighthouse keeper catches glowing jellyfish from a stormy pier | 28,6 s | 33,1 s | 1 | **77,5 s** |

Medián **70,4 s** (T1 v podobném běhu bez prohlížeče: 58–169 s, p50 jednoho volání 41 s).

Kroky, jak je hráč viděl vedle „Full detail“ (po jednom, každý nejméně 1,5 s):
- ježek: Reading your idea… → Building the world… → Hero: hedgehog → Rival: goal → Place: mossy hill → Controls: Drag to aim → Checking it can be won… → Fixing one thing… → Checking… → Fixing one thing…
- vydra: … → Hero: otter → Rival: grumpy frog → Place: A rainy canal; the otter rides a… → Controls: Drag/arrows steer → Checking… → Fixing… → Checking… → Fixing…
- strážce majáku: … → Hero: lighthouse keeper → Place: A stormy pier beside a… → Controls: Drag or arrows to move → Checking… → Fixing…

Snímky v `oracle/`: `<věta>-hero.png` (proužek „Hero: …“), `<věta>-checking.png` („Checking it can be won…“), `<věta>-ai.png` (otevřená AI verze, „Full detail“ vybráno). Surová data `oracle/oracle.json`.

## Co z toho plyne (inference)

- **Hráč čeká zhruba 30 s se slovy, ne s tečkou:** volby režiséra se objeví ve 29–37 s, pak 30–45 s běží kontrola robotem a opravná kola. Opravy tedy trvají skoro tolik, co samotný režisér – další zrychlení hledat v počtu opravných kol (2 ze 3 vět šly dvakrát), ne ve schématu (T1).
- **„Rival: goal“ byla chyba:** u ježka se střílí do branek a uhýbá šiškám; jako soupeř se ukázala branka. Opraveno v `7a7745d6` – soupeř je kdo honí, pak čemu se uhýbá, nikdy cíl.
- **Scéna AI verze strážce majáku** ukazuje déšť nad plochou olivovou zemí, molo ani moře vidět nejsou – spadá do P73D (scény), tady se neřeší.
## Po T4: řádek „Made by …“

Čtvrtá nová věta po T4 (`d5701b7c`, nový build): *a mole digs tunnels under a carrot farm while dodging a hungry badger*.
- AI verze za **92,8 s**, 3 volání; kroky už ukazují „Rival: hungry badger“ (oprava `7a7745d6` vidět).
- Uložená verze nese `provenance` `{ model: "gpt-6-astra", ms: 92876, cached: false, revised: 2 }` – `ms` = režie 92 507 + kompilace 189 + kontrola 179.
- List „About this game“ (z karty pauzy) ukazuje **„Made by gpt-6-astra in 92.9 s · fresh · revised 2 times“** – snímek `oracle/mole-about.png`.
- Jméno modelu u codex-cli je to z nastavení (CLI žádné nevrací); u Groq a jiných hostovaných se vezme to, které poskytovatel vrátí.
