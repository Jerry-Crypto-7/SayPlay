"""Knihovna panoramat: 3 na každý look + nejčastější prostředí z korpusů.

  uv run --project ops/env python ops/env/batch.py settings      # evals/play/env/settings.json
  node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/env python ops/env/batch.py generate
  uv run --project ops/env python ops/env/batch.py catalog       # src/play/arcade/look/env-catalog.json

`generate` přeskočí panorama, které už na disku je, takže přerušená dávka pokračuje.
"""

import json
import re
import sys
import time
from pathlib import Path

import numpy as np
from panorama import LICENSE, generate, write
from PIL import Image
from seam import horizon_color

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public/assets/worldstream/env"
URL = "/assets/worldstream/env"
SETTINGS = ROOT / "evals/play/env/settings.json"
CATALOG = ROOT / "src/play/arcade/look/env-catalog.json"
CORPORA = [
    "evals/play/demand/corpus.json",
    "evals/play/fidelity/corpus.json",
    "evals/play/fidelity/judge-10.json",
]
EXTRA = 40
# 18 × 3 + 40 panoramat do 30 MB: 260 kB + 25 kB na jedno.
MAX_BYTES, MAX_LOW_BYTES = 260_000, 25_000

# Tři varianty na look: (prompt, štítky). Štítky jsou slova, podle kterých je `envFor` najde.
LOOKS: dict[str, list[tuple[str, list[str]]]] = {
    "meadow": [
        (
            "green rolling meadow with wildflowers under a blue sky",
            ["meadow", "field", "grass", "flowers"],
        ),
        (
            "sunny city park with trees, paths and a fountain",
            ["park", "trees", "garden"],
        ),
        (
            "farmland with red barn, hills and fields",
            ["farm", "field", "barn", "countryside", "hill"],
        ),
    ],
    "city": [
        (
            "modern city street with tall buildings and traffic",
            ["city", "street", "road", "traffic", "town"],
        ),
        (
            "city rooftops at sunset with skyscrapers",
            ["city", "rooftop", "skyscraper", "sunset"],
        ),
        ("neon city at night with glowing signs", ["city", "neon", "night", "street"]),
    ],
    "mall": [
        (
            "bright shopping mall interior with shop fronts and escalators",
            ["mall", "shopping", "shop"],
        ),
        ("mall food court with tables and plants", ["mall", "food court", "shopping"]),
        (
            "glass-roofed shopping plaza with storefronts",
            ["mall", "plaza", "shopping", "store"],
        ),
    ],
    "supermarket": [
        (
            "supermarket aisles with shelves full of groceries",
            ["supermarket", "grocery", "store", "shelves"],
        ),
        ("supermarket checkout area with tills", ["supermarket", "checkout", "store"]),
        (
            "outdoor street market with stalls and awnings",
            ["market", "bazaar", "stall"],
        ),
    ],
    "living_room": [
        (
            "cozy living room with sofa, lamp and bookshelves",
            ["living room", "house", "home", "sofa"],
        ),
        (
            "messy kid bedroom with toys on the floor",
            ["bedroom", "house", "toy", "home"],
        ),
        ("office interior with desks and windows", ["office", "desk", "work"]),
    ],
    "factory": [
        (
            "industrial factory hall with machines and pipes",
            ["factory", "machine", "industrial"],
        ),
        (
            "warehouse with stacked crates and pallets",
            ["warehouse", "crates", "storage"],
        ),
        ("science laboratory with glowing equipment", ["laboratory", "lab", "science"]),
    ],
    "forest": [
        (
            "dense green forest with tall trees and sunbeams",
            ["forest", "woods", "trees"],
        ),
        ("dark misty forest at dusk", ["forest", "dark", "woods", "night"]),
        (
            "forest campsite with a tent and campfire",
            ["forest", "camp", "campsite", "tent"],
        ),
    ],
    "jungle": [
        (
            "lush tropical jungle with vines and giant leaves",
            ["jungle", "rainforest", "tropical"],
        ),
        ("jungle river winding between trees", ["jungle", "river", "water"]),
        ("misty swamp with mangroves", ["swamp", "marsh", "jungle"]),
    ],
    "desert": [
        ("sand dunes desert under a hot sun", ["desert", "dune", "sand"]),
        ("red rock canyon desert", ["canyon", "desert", "rock"]),
        (
            "australian outback with red earth and scrub",
            ["outback", "australia", "desert", "bush"],
        ),
    ],
    "beach": [
        (
            "sunny tropical beach with palm trees and turquoise sea",
            ["beach", "tropical", "palm", "sea"],
        ),
        (
            "small tropical island surrounded by ocean",
            ["island", "tropical", "beach", "ocean"],
        ),
        (
            "seaside promenade beach with sand and waves",
            ["beach", "shore", "coast", "sea"],
        ),
    ],
    "ocean": [
        (
            "open ocean with waves under a bright sky",
            ["ocean", "sea", "waves", "water"],
        ),
        ("harbor with boats and piers", ["harbor", "boat", "port", "sea"]),
        (
            "pirate sea with a wooden ship on the horizon",
            ["pirate", "ship", "sea", "ocean"],
        ),
    ],
    "underwater": [
        (
            "underwater coral reef with fish and light rays",
            ["underwater", "reef", "coral", "sea"],
        ),
        (
            "deep sea floor with rocks and kelp",
            ["underwater", "deep sea", "seabed", "kelp"],
        ),
        ("sunken shipwreck underwater", ["underwater", "shipwreck", "sunken", "sea"]),
    ],
    "snow": [
        ("snowy pine forest in winter", ["snow", "forest", "pine", "winter"]),
        ("snowy mountains and glacier", ["snow", "mountain", "glacier", "ice"]),
        (
            "frozen lake with ice and snowbanks",
            ["ice", "frozen", "lake", "snow", "winter"],
        ),
    ],
    "volcano": [
        ("erupting volcano with lava rivers", ["volcano", "lava", "eruption"]),
        (
            "lava field with glowing cracks and smoke",
            ["lava", "magma", "volcano", "fire"],
        ),
        ("dark volcanic island with ash clouds", ["volcano", "island", "ash"]),
    ],
    "cave": [
        ("underground cave with stalactites", ["cave", "cavern", "underground"]),
        ("crystal cave with glowing gems", ["cave", "crystal", "gems"]),
        (
            "abandoned mine tunnel with rails and lanterns",
            ["mine", "mining", "tunnel", "cave"],
        ),
    ],
    "space": [
        (
            "outer space with stars, nebula and planets",
            ["space", "stars", "galaxy", "planet"],
        ),
        (
            "red martian landscape with rocks and a dusty sky",
            ["mars", "planet", "space", "red planet"],
        ),
        (
            "grey lunar surface with craters and earth in the sky",
            ["moon", "lunar", "space", "crater"],
        ),
    ],
    "castle": [
        (
            "medieval stone castle with towers and flags",
            ["castle", "medieval", "kingdom", "tower"],
        ),
        (
            "castle courtyard with walls and torches",
            ["castle", "fortress", "wall", "medieval"],
        ),
        (
            "fantasy kingdom with castle on a hill",
            ["kingdom", "castle", "fantasy", "hill"],
        ),
    ],
    "graveyard": [
        (
            "spooky graveyard at night with tombstones and fog",
            ["graveyard", "cemetery", "spooky", "night"],
        ),
        (
            "haunted house on a hill under a full moon",
            ["haunted", "house", "spooky", "night"],
        ),
        (
            "abandoned haunted hospital corridor",
            ["hospital", "haunted", "abandoned", "spooky"],
        ),
    ],
}

# Slovník prostředí z vět: (id, vzor, prompt, štítky). Pořadí rozhoduje při shodné četnosti.
VOCAB: list[tuple[str, str, str, list[str]]] = [
    (
        "tower",
        r"tower",
        "tall stone tower rising into the clouds",
        ["tower", "tall", "height"],
    ),
    (
        "haunted-castle",
        r"haunted castle",
        "haunted castle with ghosts at night",
        ["haunted", "castle", "spooky", "night"],
    ),
    (
        "candy-land",
        r"candy",
        "candy land with lollipop trees and chocolate hills",
        ["candy", "sweets", "chocolate"],
    ),
    (
        "pond",
        r"pond|lily pads?",
        "calm pond with lily pads and reeds",
        ["pond", "lily pads", "lake", "water"],
    ),
    (
        "rooftops",
        r"rooftops?",
        "city rooftops with chimneys and water tanks",
        ["rooftop", "city", "roof"],
    ),
    (
        "spaceship",
        r"spaceship|space ?station",
        "inside a spaceship with control panels and windows to space",
        ["spaceship", "space station", "space", "sci-fi"],
    ),
    (
        "temple",
        r"temple",
        "ancient jungle temple ruins",
        ["temple", "ruins", "ancient", "jungle"],
    ),
    (
        "village",
        r"villages?",
        "medieval village with cottages",
        ["village", "town", "cottage", "medieval"],
    ),
    (
        "sky",
        r"\bsky\b|clouds?",
        "above the clouds in a bright blue sky",
        ["sky", "clouds", "air"],
    ),
    (
        "hills",
        r"hills?",
        "green rolling hills with a winding path",
        ["hill", "countryside", "grass"],
    ),
    (
        "mountain-road",
        r"mountain",
        "mountain road with cliffs and pine trees",
        ["mountain", "road", "cliff"],
    ),
    (
        "skyscraper",
        r"skyscrapers?",
        "glass skyscraper office floor overlooking the city",
        ["skyscraper", "office", "tower", "city"],
    ),
    (
        "school",
        r"school|classroom|teachers",
        "school classroom with desks and a blackboard",
        ["school", "classroom"],
    ),
    (
        "kitchen",
        r"kitchen",
        "busy restaurant kitchen with stoves and pans",
        ["kitchen", "restaurant", "cooking"],
    ),
    (
        "mining-colony",
        r"mining colony|colony",
        "sci-fi mining colony on an alien planet",
        ["colony", "mine", "mining", "planet", "space"],
    ),
    (
        "asteroid-field",
        r"asteroids?",
        "asteroid field in deep space",
        ["asteroid", "space", "rocks"],
    ),
    (
        "pirate-ship",
        r"pirate",
        "pirate ship deck on the open sea",
        ["pirate", "ship", "sea"],
    ),
    (
        "arena",
        r"arena",
        "sports arena with crowd stands and lights",
        ["arena", "stadium", "crowd"],
    ),
    (
        "parking-lot",
        r"parking",
        "jammed parking lot full of cars",
        ["parking", "cars", "lot"],
    ),
    (
        "race-track",
        r"race|racing|track",
        "car race track with grandstands",
        ["race track", "racing", "road", "track"],
    ),
    (
        "backyard",
        r"backyard",
        "suburban backyard with fence, grass and a sprinkler",
        ["backyard", "garden", "yard", "house"],
    ),
    ("garden", r"garden", "flower garden with hedges", ["garden", "flowers", "hedge"]),
    (
        "lake",
        r"\blake\b",
        "mountain lake with a wooden dock",
        ["lake", "water", "dock"],
    ),
    ("sunset", r"sunset", "golden sunset over hills", ["sunset", "evening", "sky"]),
    (
        "carnival",
        r"carnival|circus|fair",
        "haunted carnival with rides and lights at night",
        ["carnival", "circus", "fair", "night"],
    ),
    (
        "disco",
        r"disco|dance",
        "disco dance floor with colored lights",
        ["disco", "dance", "club", "party"],
    ),
    (
        "party",
        r"party|birthday",
        "birthday party room with balloons and streamers",
        ["party", "birthday", "balloons"],
    ),
    (
        "museum",
        r"museum",
        "museum hall with exhibits and paintings",
        ["museum", "gallery", "exhibit"],
    ),
    (
        "dungeon",
        r"dungeon",
        "stone dungeon with torches and chains",
        ["dungeon", "prison", "stone"],
    ),
    (
        "subway",
        r"subway|metro",
        "subway station with train and tiles",
        ["subway", "metro", "train", "station"],
    ),
    (
        "restaurant",
        r"restaurant|diner",
        "cozy restaurant dining room",
        ["restaurant", "diner", "tables"],
    ),
    (
        "cafe",
        r"caf[eé]|coffee",
        "cozy rainy cafe interior with window view",
        ["cafe", "café", "coffee", "rain"],
    ),
    (
        "toy-room",
        r"\btoys?\b",
        "giant toy room with blocks and toy cars",
        ["toy", "playroom", "kids"],
    ),
    (
        "prison",
        r"prison|jail",
        "prison yard with fences and watchtowers",
        ["prison", "jail", "yard"],
    ),
    ("cabin", r"cabin", "log cabin in the woods", ["cabin", "woods", "forest"]),
    (
        "alley",
        r"alley",
        "narrow city alley with trash cans",
        ["alley", "city", "street", "night"],
    ),
    ("bridge", r"bridge", "long suspension bridge over a river", ["bridge", "river"]),
    (
        "storm",
        r"storm|thunder",
        "stormy sky with lightning over plains",
        ["storm", "lightning", "rain"],
    ),
    (
        "rainbow-road",
        r"rainbow",
        "rainbow road floating in space",
        ["rainbow", "road", "space"],
    ),
    (
        "monaco",
        r"monaco|grand prix",
        "monaco street race circuit by the harbor",
        ["monaco", "race track", "harbor", "city"],
    ),
    (
        "pool",
        r"\bpool\b|swimming",
        "outdoor swimming pool with deck chairs",
        ["pool", "swimming", "water"],
    ),
    (
        "wild-west",
        r"western|wild west|saloon|high noon",
        "wild west town with saloon at high noon",
        ["wild west", "western", "saloon", "desert"],
    ),
    (
        "hospital",
        r"hospital|clinic",
        "bright hospital ward",
        ["hospital", "ward", "clinic"],
    ),
    (
        "glacier",
        r"glacier",
        "blue glacier with penguins and seals",
        ["glacier", "ice", "arctic", "snow"],
    ),
]


def corpus_texts() -> list[str]:
    texts: list[str] = []
    for rel in CORPORA:
        data = json.loads((ROOT / rel).read_text(encoding="utf-8"))
        rows = data if isinstance(data, list) else data["sentences"]
        texts += [row["text"].lower() for row in rows]
    return texts


def settings() -> list[dict]:
    texts = corpus_texts()
    rows = []
    for order, (sid, pattern, prompt, tags) in enumerate(VOCAB):
        count = sum(1 for t in texts if re.search(rf"\b(?:{pattern})", t))
        rows.append(
            {"id": sid, "count": count, "prompt": prompt, "tags": tags, "order": order}
        )
    rows.sort(key=lambda r: (-r["count"], r["order"]))
    chosen = [r for r in rows if r["count"] > 0][:EXTRA]
    return [{k: v for k, v in r.items() if k != "order"} for r in chosen]


# P57 T10: světy sad T9, pro které `envFor` žádné panorama nenašel (dojo, highway) nebo našel
# jen plážový ostrov (floating island). Mimo korpusový výběr, ať se výběr 40 nepřeskládá.
P57_SETTINGS = [
    {
        "id": "dojo",
        "prompt": "japanese dojo courtyard with wooden halls, cherry blossoms and paper lanterns",
        "tags": ["dojo", "martial arts"],
    },
    {
        "id": "highway",
        "prompt": "wide highway through open countryside with overpasses and road signs under a blue sky",
        "tags": ["highway", "freeway", "motorway"],
    },
    {
        "id": "floating-island",
        "prompt": "floating sky islands with waterfalls high above the clouds",
        "tags": ["floating island", "floating", "sky island"],
    },
]


def jobs() -> list[dict]:
    out = []
    for look, variants in LOOKS.items():
        for i, (prompt, tags) in enumerate(variants):
            out.append(
                {
                    "id": f"{look.replace('_', '-')}-{i + 1}",
                    "look": look,
                    "prompt": prompt,
                    "tags": tags,
                    "seed": i,
                }
            )
    chosen = json.loads(SETTINGS.read_text(encoding="utf-8"))["settings"] + P57_SETTINGS
    for row in chosen:
        out.append(
            {
                "id": f"set-{row['id']}",
                "look": None,
                "prompt": row["prompt"],
                "tags": row["tags"],
                "seed": 0,
            }
        )
    return out


def cmd_settings() -> None:
    rows = settings()
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    about = (
        f"P29C T3: setting vocabulary counted over {', '.join(CORPORA)} ({len(corpus_texts())} sentences); "
        f"top {EXTRA} with at least one hit, ties by vocabulary order in ops/env/batch.py."
    )
    SETTINGS.write_text(
        json.dumps({"about": about, "settings": rows}, indent=1, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    print(f"{len(rows)} settings -> {SETTINGS}")


def cmd_generate() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for job in jobs():
        if (PUBLIC / f"{job['id']}.webp").exists():
            continue
        started = time.perf_counter()
        pixels = generate(job["prompt"], job["seed"])
        meta = write(pixels, PUBLIC, job["id"], MAX_BYTES, MAX_LOW_BYTES)
        print(
            f"{job['id']}: {time.perf_counter() - started:.1f} s, {meta['bytes']} B",
            flush=True,
        )


def cmd_catalog() -> None:
    entries = []
    for job in jobs():
        path = PUBLIC / f"{job['id']}.webp"
        pixels = np.asarray(Image.open(path).convert("RGB"))
        entries.append(
            {
                "id": job["id"],
                "look": job["look"],
                "tags": job["tags"],
                "prompt": job["prompt"],
                "url": f"{URL}/{job['id']}.webp",
                "low": f"{URL}/{job['id']}-low.webp",
                "horizon": "#%02x%02x%02x" % horizon_color(pixels),
                "license": LICENSE,
            }
        )
    CATALOG.write_text(
        json.dumps(
            {
                "about": "P29C T3 panorama library, written by ops/env/batch.py catalog.",
                "entries": entries,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"{len(entries)} entries -> {CATALOG}")


def cmd_bake() -> None:
    """P30A T4: `bake <jobs.json> <outdir>` – předpečená panoramata pro
    `src/play/env/baked.json`. Úlohy `[{id, prompt}]` z `scripts/cloud/bake-panoramas.mjs`;
    vedle obrázků zapíše `<id>.json` s horizontem. Hotové přeskočí."""
    todo = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    out = Path(sys.argv[3])
    for job in todo:
        if (out / f"{job['id']}.webp").exists():
            continue
        started = time.perf_counter()
        meta = write(
            generate(job["prompt"], 0), out, job["id"], MAX_BYTES, MAX_LOW_BYTES
        )
        (out / f"{job['id']}.json").write_text(
            json.dumps({**meta, "setting": job["prompt"]}), encoding="utf-8"
        )
        print(
            f"{job['id']}: {time.perf_counter() - started:.1f} s, {meta['bytes']} B",
            flush=True,
        )


if __name__ == "__main__":
    {
        "settings": cmd_settings,
        "generate": cmd_generate,
        "catalog": cmd_catalog,
        "bake": cmd_bake,
    }[sys.argv[1]]()
