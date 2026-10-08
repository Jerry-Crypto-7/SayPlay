"""Independent authoring only: no game implementation, extraction or scoring imports."""
import collections
import hashlib
import json
from pathlib import Path
import unicodedata

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[3]
rows = []

def add(kind, hero, setting, sentence, *requirements):
    triples = []
    for requirement in requirements:
        verb, _, obj = requirement.partition(':')
        if verb.startswith('!'):
            triples.append(dict(actor=obj, verb=verb[1:], object=hero))
        else:
            triples.append(dict(actor=hero, verb=verb, object=obj or None))
    rows.append(dict(id=f'p42-r4-ho-{len(rows)+1:03}', kind=kind, sentence=sentence,
                     hero=hero, setting=setting, essential=triples,
                     unsupported=kind == 'unsupported'))

M = 'multi-action'
add(M,'rabbit','garden','A rabbit runs through the garden collecting carrots while foxes chase it.','run','collect:carrot','!chaser:fox')
add(M,'owl','forest','An owl flies through the forest, catches mice and dodges falling branches.','flap','catch:mouse','!hazard:branch')
add(M,'truck','desert','Drive a truck across the desert, racing jeeps and shooting rockets.','drive','race','!rival:jeep','shoot:rocket')
add(M,'frog','swamp','A frog jumps across the swamp gathering pearls as stones fall around it.','jump','collect:pearl','!hazard:stone')
add(M,'seal','ocean','A seal swims in the ocean to catch squid while a shark chases it.','glide','catch:squid','!chaser:shark')
add(M,'knight','castle','A knight walks through the castle, collects keys and fights skeletons.','walk','collect:key','fight:skeleton')
add(M,'robot','station','A robot roams the station shooting drones and collecting batteries.','roam','shoot:drone','collect:battery')
add(M,'bear','stadium','A bear plays soccer in the stadium against wolves and kicks the ball into the goal.','ball','!rival:wolf','kick:ball','score:goal')
add(M,'fox','village','A fox runs through the village delivering letters and avoiding carts.','run','deliver:letter','!obstacle:cart')
add(M,'dragon','mountain','A dragon flies over the mountain, throws fireballs and catches ravens.','flap','throw:fireball','catch:raven')
add(M,'car','city','A car races buses through the city while bombs drop from above.','drive','race','!rival:bus','!hazard:bomb')
add(M,'goat','cliff','A goat jumps up the cliff to collect flags while an eagle pursues it.','jump','collect:flag','!chaser:eagle')
add(M,'penguin','lake','A penguin swims across the lake, gathers fish and dodges falling ice.','glide','collect:fish','!hazard:ice')
add(M,'pirate','island','A pirate walks around the island, duels a crab and then escapes.','walk','duel:crab','escape')
add(M,'cat','warehouse','A cat roams the warehouse, chases rats and collects stars.','roam','catch:rat','collect:star')
add(M,'dog','park','A dog plays football against cats in the park while apples fall onto the field.','ball','!rival:cat','!hazard:apple')
add(M,'mouse','tunnel','A mouse runs through the tunnel, picks up cheese and reaches the exit.','run','collect:cheese','reach:exit')
add(M,'helicopter','valley','A helicopter flies down the valley shooting missiles while planes race it to the finish.','flap','shoot:missile','race','!rival:plane')
add(M,'bus','road','A bus drives along the road, collects coins and delivers parcels.','drive','collect:coin','deliver:parcel')
add(M,'kangaroo','canyon','A kangaroo jumps through the canyon, catches butterflies and avoids boulders.','jump','catch:butterfly','!obstacle:boulder')
add(M,'turtle','reef','A turtle swims along the reef collecting shells and rescuing fish.','glide','collect:shell','interact:fish')
add(M,'samurai','temple','A samurai walks through the temple, fights goblins and then runs to the gate.','walk','fight:goblin','run','reach:gate')

P = 'paraphrase'
add(P,'horse','field','Make a race across the field with a horse trying to outrun zebras.','run','race','!rival:zebra')
add(P,'bat','cave','I want a cave flight with a bat scooping up gems.','flap','collect:gem')
add(P,'van','highway','Put me behind the wheel of a van on the highway with coins to pick up.','drive','collect:coin')
add(P,'fox','forest','Send a fox on a forest stroll, with a basket of berries to gather.','walk','collect:berry')
add(P,'fish','river','Give me an underwater swim down the river as a fish escaping a crocodile.','glide','escape','!chaser:crocodile')
add(P,'robot','arena','Let me move freely around the arena as a robot and fire at turrets.','roam','shoot:turret')
add(P,'monkey','jungle','Have a monkey hop through the jungle after a runaway chicken.','jump','catch:chicken')
add(P,'rabbit','stadium','Let a rabbit have a soccer match in the stadium versus pigs.','ball','!rival:pig')

N = 'negation'
add(N,'wolf','forest','A wolf runs through the forest collecting bones, but do not add shooting.','run','collect:bone')
add(N,'eagle','mountain','An eagle flies over the mountain without collecting anything.','flap')
add(N,'car','track','A car races trucks on the track, but no missiles or shooting.','drive','race','!rival:truck')
add(N,'frog','pond','A frog jumps around the pond; do not make it fight.','jump')
add(N,'dolphin','ocean','A dolphin swims through the ocean catching fish, with no chasing sharks.','glide','catch:fish')
add(N,'knight','village','A knight walks through the village and must not stop collecting coins.','walk','collect:coin')
add(N,'robot','factory','A robot roams the factory; keep shooting drones, but never collect batteries.','roam','shoot:drone')
add(N,'cat','stadium','A cat plays soccer in the stadium without rival teams.','ball')
add(N,'pirate','beach','A pirate runs along the beach, does not throw bombs, and picks up shells.','run','collect:shell')
add(N,'dragon','valley','A dragon flies through the valley; do not stop shooting fireballs.','flap','shoot:fireball')

U = 'unsupported'
add(U,'rabbit','kitchen','A rabbit bakes muffins in the kitchen.','bake:muffin')
add(U,'bear','cabin','A bear knits scarves inside a cabin.','knit:scarf')
add(U,'owl','library','An owl translates poems in a library.','translate:poem')
add(U,'fox','studio','A fox paints portraits in a studio.','paint:portrait')
add(U,'robot','school','A robot teaches arithmetic at a school.','teach:arithmetic')
add(U,'penguin','theater','A penguin sings lullabies in a theater.','sing:lullaby')
add(U,'cat','house','A cat sews curtains in a house.','sew:curtain')
add(U,'dog','shop','A dog repairs clocks in a shop.','repair:clock')

S = 'single'
add(S,'cheetah','savanna','A cheetah runs across the savanna at sunrise.','run')
add(S,'deer','forest','I want to be a deer running through a misty forest.','run')
add(S,'kangaroo','desert','A kangaroo jumps across the quiet desert.','jump')
add(S,'goat','mountain','Make a game about a goat jumping on a snowy mountain.','jump')
add(S,'parrot','jungle','A parrot flies through the jungle canopy.','flap')
add(S,'plane','sky','Let me fly a plane across the evening sky.','flap')
add(S,'tractor','farm','Drive a tractor around a sunny farm.','drive')
add(S,'motorcycle','city','I want to drive a motorcycle through the city at night.','drive')
add(S,'robot','hangar','A robot roams an empty hangar.','roam')
add(S,'crab','beach','A crab moves freely around the beach.','roam')
add(S,'whale','ocean','A whale swims through the deep ocean.','glide')
add(S,'otter','river','Let an otter swim along the river.','glide')
add(S,'wizard','village','A wizard walks around a peaceful village.','walk')
add(S,'tiger','temple','Play as a tiger walking through an ancient temple.','walk')
add(S,'panda','park','A panda plays soccer in a park.','ball')
add(S,'fox','stadium','Make a football game with a fox in a stadium.','ball')

expected = {'multi-action':22,'paraphrase':8,'negation':10,'unsupported':8,'single':16}
assert dict(collections.Counter(r['kind'] for r in rows)) == expected
assert len(rows) == 64 and len({r['id'] for r in rows}) == 64
threats = {'chaser','guard','hazard','obstacle','rival'}
for row in rows:
    for triple in row['essential']:
        if triple['verb'] in threats:
            assert triple['object'] == row['hero']
        else:
            assert triple['actor'] == row['hero']
def norm(s):
    return ' '.join(unicodedata.normalize('NFKC',s).lower().split())
def sentences(value):
    if isinstance(value, dict):
        if isinstance(value.get('sentence'), str):
            yield value['sentence']
        for key,item in value.items():
            if key != 'sentence': yield from sentences(item)
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str): yield item
            else: yield from sentences(item)
assert len({norm(r['sentence']) for r in rows}) == 64
comparisons = {}
for name in ['p30/test-200.json','p41/sentences.json','p42/sentences.json','p42/round2/sentences.json','p42/round3/sentences.json']:
    old = set(map(norm, sentences(json.loads((ROOT/'evals/play'/name).read_text(encoding='utf-8-sig')))))
    assert old, f'No sentences found in {name}'
    count = len(old & {norm(r['sentence']) for r in rows})
    comparisons[name] = dict(referenceUniqueSentences=len(old), normalizedOverlap=count)
    assert count == 0, f'Overlap in {name}'
data = dict(version=1, about='Independently authored P42 round4 held-out; authored and sealed before any extraction, drafting or scoring.', groups={'held-out':rows})
raw = (json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
with (OUT/'sentences.json').open('xb') as f: f.write(raw)
seal = dict(sha256=hashlib.sha256(raw).hexdigest(), count=64, distribution=expected,
            normalizedOverlap=comparisons, preparation='No extraction, drafting, scoring, API calls, implementation inspection or prior-result inspection. Prior sentences loaded only programmatically for schema and overlap.')
with (OUT/'dataset-seal.json').open('x',encoding='utf-8',newline='\n') as f:
    f.write(json.dumps(seal,indent=2)+'\n')
source = (OUT.parent/'round3/final.measure.ts').read_bytes()
runner = source.replace(b'round3',b'round4').replace(b'ROUND3',b'ROUND4')
with (OUT/'final.measure.ts').open('xb') as f: f.write(runner)
assert runner.replace(b'round4',b'round3').replace(b'ROUND4',b'ROUND3') == source
print(json.dumps({'sha256':seal['sha256'],'count':64,'overlap':0,'runnerMechanicallyIdenticalExceptRoundNames':True}))
