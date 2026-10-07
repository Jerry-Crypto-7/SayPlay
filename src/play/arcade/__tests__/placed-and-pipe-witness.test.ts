import {expect,it} from 'vitest';
import {arcadeWorldOf} from '@/play/arcade/compile';
import {runBot,verifyArcade} from '@/play/arcade/verify';
import {loadRapier} from '@/play/arcade/physics/world';
import {ARCADE_LIBRARY} from '@/play/arcade/library';
import {NO_INPUT} from '@/play/arcade/contract';
import type {GameSpecV1} from '@/play/spec';
const report: { rows: {id:string;spec:GameSpecV1}[] } = {
  "rows": [
    {
      "id": "pa-013",
      "spec": {
        "schema": "gamespec.v1",
        "control": "flap",
        "controlParams": {
          "lengthM": 220,
          "rise": true,
          "feel": 2
        },
        "genre": {
          "id": "flap",
          "mode": "default",
          "compilerVersion": "genre.v1"
        },
        "title": "Bird Flight",
        "archetype": "hazard_crossing",
        "targetDurationSec": 60,
        "theme": {
          "setting": "bright sky",
          "mood": "cheerful"
        },
        "objective": {
          "kind": "reach",
          "description": "Flap through the gaps between the pipes to the finish.",
          "role": "finish"
        },
        "mechanics": [
          {
            "id": "health",
            "params": {
              "max": 3
            }
          }
        ],
        "roles": [
          {
            "id": "player",
            "kind": "player",
            "label": "bird",
            "count": 1
          },
          {
            "id": "pipe",
            "kind": "hazard",
            "label": "pipe",
            "count": 1
          },
          {
            "id": "coin",
            "kind": "collectible",
            "label": "coin",
            "count": 1
          },
          {
            "id": "finish",
            "kind": "exit",
            "label": "finish line",
            "count": 1
          }
        ],
        "tutorial": {
          "goalLine": "Fly through the gaps to the finish. They get tighter.",
          "controlsHint": "Tap or Space to flap."
        },
        "verification": [
          {
            "id": "winnable",
            "kind": "reachability",
            "assert": {
              "runState": "won"
            }
          }
        ],
        "budgets": {
          "maxEntities": 40,
          "maxRules": 120,
          "maxTriangles": 200000
        },
        "scoring": {}
      }
    },
    {
      "id": "pa-014",
      "spec": {
        "schema": "gamespec.v1",
        "control": "flap",
        "controlParams": {
          "lengthM": 220,
          "rise": true,
          "feel": 2
        },
        "genre": {
          "id": "flap",
          "mode": "default",
          "compilerVersion": "genre.v1"
        },
        "title": "Bird Flight",
        "archetype": "hazard_crossing",
        "targetDurationSec": 60,
        "theme": {
          "setting": "gaps",
          "mood": "cheerful"
        },
        "objective": {
          "kind": "reach",
          "description": "Flap through the gaps between the pipes to the finish.",
          "role": "finish"
        },
        "mechanics": [
          {
            "id": "health",
            "params": {
              "max": 3
            }
          }
        ],
        "roles": [
          {
            "id": "player",
            "kind": "player",
            "label": "bird",
            "count": 1
          },
          {
            "id": "pipe",
            "kind": "hazard",
            "label": "pipe",
            "count": 1
          },
          {
            "id": "coin",
            "kind": "collectible",
            "label": "coin",
            "count": 1
          },
          {
            "id": "finish",
            "kind": "exit",
            "label": "finish line",
            "count": 1
          }
        ],
        "tutorial": {
          "goalLine": "Fly through the gaps to the finish. They get tighter.",
          "controlsHint": "Tap or Space to flap."
        },
        "verification": [
          {
            "id": "winnable",
            "kind": "reachability",
            "assert": {
              "runState": "won"
            }
          }
        ],
        "budgets": {
          "maxEntities": 40,
          "maxRules": 120,
          "maxTriangles": 200000
        },
        "scoring": {}
      }
    },
    {
      "id": "pa-015",
      "spec": {
        "schema": "gamespec.v1",
        "control": "flap",
        "controlParams": {
          "lengthM": 220,
          "rise": true,
          "feel": 2
        },
        "genre": {
          "id": "flap",
          "mode": "default",
          "compilerVersion": "genre.v1"
        },
        "title": "Bird Flight",
        "archetype": "hazard_crossing",
        "targetDurationSec": 60,
        "theme": {
          "setting": "bright sky",
          "mood": "cheerful"
        },
        "objective": {
          "kind": "reach",
          "description": "Flap through the gaps between the pipes to the finish.",
          "role": "finish"
        },
        "mechanics": [
          {
            "id": "health",
            "params": {
              "max": 3
            }
          }
        ],
        "roles": [
          {
            "id": "player",
            "kind": "player",
            "label": "bird",
            "count": 1
          },
          {
            "id": "pipe",
            "kind": "hazard",
            "label": "pipe",
            "count": 1
          },
          {
            "id": "coin",
            "kind": "collectible",
            "label": "coin",
            "count": 1
          },
          {
            "id": "finish",
            "kind": "exit",
            "label": "finish line",
            "count": 1
          }
        ],
        "tutorial": {
          "goalLine": "Fly through the gaps to the finish. They get tighter.",
          "controlsHint": "Tap or Space to flap."
        },
        "verification": [
          {
            "id": "winnable",
            "kind": "reachability",
            "assert": {
              "runState": "won"
            }
          }
        ],
        "budgets": {
          "maxEntities": 40,
          "maxRules": 120,
          "maxTriangles": 200000
        },
        "scoring": {}
      }
    },
    {
      "id": "pa-016",
      "spec": {
        "schema": "gamespec.v1",
        "control": "flap",
        "controlParams": {
          "lengthM": 220,
          "rise": true,
          "feel": 2
        },
        "genre": {
          "id": "flap",
          "mode": "default",
          "compilerVersion": "genre.v1"
        },
        "title": "Bird Flight",
        "archetype": "hazard_crossing",
        "targetDurationSec": 60,
        "theme": {
          "setting": "bright sky",
          "mood": "cheerful"
        },
        "objective": {
          "kind": "reach",
          "description": "Flap through the gaps between the pipes to the finish.",
          "role": "finish"
        },
        "mechanics": [
          {
            "id": "health",
            "params": {
              "max": 3
            }
          }
        ],
        "roles": [
          {
            "id": "player",
            "kind": "player",
            "label": "bird",
            "count": 1
          },
          {
            "id": "pipe",
            "kind": "hazard",
            "label": "pipe",
            "count": 1
          },
          {
            "id": "coin",
            "kind": "collectible",
            "label": "coin",
            "count": 1
          },
          {
            "id": "finish",
            "kind": "exit",
            "label": "finish line",
            "count": 1
          }
        ],
        "tutorial": {
          "goalLine": "Fly through the gaps to the finish. They get tighter.",
          "controlsHint": "Tap or Space to flap."
        },
        "verification": [
          {
            "id": "winnable",
            "kind": "reachability",
            "assert": {
              "runState": "won"
            }
          }
        ],
        "budgets": {
          "maxEntities": 40,
          "maxRules": 120,
          "maxTriangles": 200000
        },
        "scoring": {}
      }
    },
    {
      "id": "si-011",
      "spec": {
        "schema": "gamespec.v1",
        "control": "timing",
        "controlParams": {
          "mode": "stack",
          "speed": "slow",
          "rounds": 36,
          "rise": true,
          "feel": 2
        },
        "genre": {
          "id": "timing",
          "mode": "stack",
          "compilerVersion": "genre.v1"
        },
        "title": "Fox Stack",
        "archetype": "hazard_crossing",
        "targetDurationSec": 60,
        "theme": {
          "setting": "windy hilltop",
          "mood": "playful"
        },
        "objective": {
          "kind": "reach",
          "description": "Stack 36 pancakes. Each one swings faster.",
          "role": "finish"
        },
        "mechanics": [
          {
            "id": "health",
            "params": {
              "max": 3
            }
          }
        ],
        "roles": [
          {
            "id": "player",
            "kind": "player",
            "label": "fox",
            "count": 1
          },
          {
            "id": "block",
            "kind": "collectible",
            "label": "pancake",
            "count": 36
          },
          {
            "id": "miss",
            "kind": "hazard",
            "label": "missed drop",
            "count": 1
          },
          {
            "id": "finish",
            "kind": "exit",
            "label": "of the tower",
            "count": 1
          }
        ],
        "tutorial": {
          "goalLine": "Stack 36 pancakes. Each one swings faster.",
          "controlsHint": "Tap or Space to drop the block."
        },
        "verification": [
          {
            "id": "winnable",
            "kind": "reachability",
            "assert": {
              "runState": "won"
            }
          }
        ],
        "budgets": {
          "maxEntities": 40,
          "maxRules": 120,
          "maxTriangles": 200000
        },
        "scoring": {}
      }
    },
    {
      "id": "ne-024",
      "spec": {
        "schema": "gamespec.v1",
        "control": "timing",
        "controlParams": {
          "mode": "stack",
          "speed": "slow",
          "rounds": 36,
          "rise": true,
          "feel": 2
        },
        "genre": {
          "id": "timing",
          "mode": "stack",
          "compilerVersion": "genre.v1"
        },
        "title": "Robot Stack",
        "archetype": "hazard_crossing",
        "targetDurationSec": 60,
        "theme": {
          "setting": "windy hilltop",
          "mood": "playful"
        },
        "objective": {
          "kind": "reach",
          "description": "Stack 36 crates. Each one swings faster.",
          "role": "finish"
        },
        "mechanics": [
          {
            "id": "health",
            "params": {
              "max": 3
            }
          }
        ],
        "roles": [
          {
            "id": "player",
            "kind": "player",
            "label": "robot",
            "count": 1
          },
          {
            "id": "block",
            "kind": "collectible",
            "label": "crate",
            "count": 36
          },
          {
            "id": "miss",
            "kind": "hazard",
            "label": "missed drop",
            "count": 1
          },
          {
            "id": "finish",
            "kind": "exit",
            "label": "of the tower",
            "count": 1
          }
        ],
        "tutorial": {
          "goalLine": "Stack 36 crates. Each one swings faster.",
          "controlsHint": "Tap or Space to drop the block."
        },
        "verification": [
          {
            "id": "winnable",
            "kind": "reachability",
            "assert": {
              "runState": "won"
            }
          }
        ],
        "budgets": {
          "maxEntities": 40,
          "maxRules": 120,
          "maxTriangles": 200000
        },
        "scoring": {}
      }
    }
  ]
};
it('a real flap pipe contact is observable, with no world mutation',async()=>{await loadRapier();for(const id of ['pa-013','pa-014','pa-015','pa-016'])for(const seed of [1,2,3,4,5]){const row=report.rows.find(r=>r.id===id)!;const m=arcadeWorldOf(row.spec,seed);expect(m.ok).toBe(true);if(!m.ok)continue;const before=JSON.stringify(m.world);const v=verifyArcade(m.world,undefined,m.roleBindings);expect(v.publishEligible).toBe(true);expect(v.witnesses.some(w=>w.verb==='obstacle'&&w.actor.label==='pipe'&&w.run==='probe')).toBe(true);expect(JSON.stringify(m.world)).toBe(before);}},20_000);
it('a pipe without its harmful rule cannot gain an obstacle witness',()=>{const row=report.rows.find(r=>r.id==='pa-013')!;const m=arcadeWorldOf(row.spec,1);if(!m.ok)throw Error('build');const world={...m.world,rules:m.world.rules.filter(r=>r.id!=='hit')};expect(verifyArcade(world,undefined,m.roleBindings).witnesses.some(w=>w.verb==='obstacle')).toBe(false);});
it('proves the actually placed named block for twenty paired identity cases',()=>{for(const id of ['si-011','ne-024'])for(let seed=1;seed<=5;seed++){const row=report.rows.find(r=>r.id===id)!;for(const swapped of [false,true]){const spec=swapped?{...row.spec,roles:row.spec.roles.map((r:any)=>r.id==='block'?{...r,label:'brick'}:r)}:row.spec;const m=arcadeWorldOf(spec,seed);if(!m.ok)throw Error('build');const run=runBot(m.world,undefined,{roleBindings:m.roleBindings});expect(run.outcome).toBe('won');const placed=run.witnesses.filter(w=>w.verb==='stack'&&w.evidence==='block-placed');expect(placed.length).toBeGreaterThan(0);expect(placed.every(w=>w.object?.label===(swapped?'brick':id==='si-011'?'pancake':'crate'))).toBe(true);}}});

it('idle timing creates no named stack witness',()=>{const row=report.rows.find(r=>r.id==='si-011')!;const m=arcadeWorldOf(row.spec,1);if(!m.ok)throw Error('build');const idle=runBot(m.world,{...ARCADE_LIBRARY,bots:{...ARCADE_LIBRARY.bots,[m.world.bot.id]:{...ARCADE_LIBRARY.bots[m.world.bot.id]!,decide:()=>NO_INPUT}}},{roleBindings:m.roleBindings});expect(idle.witnesses.some(w=>w.verb==='stack'&&w.object!==null)).toBe(false);});
