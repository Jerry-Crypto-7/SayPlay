const fs = require('fs');
const P = 'D:/claude/Hackaton/evals/';
const prompts = fs.readFileSync(P+'prompts.jsonl','utf8').trim().split('\n').map(JSON.parse);
const gold    = fs.readFileSync(P+'gold.jsonl','utf8').trim().split('\n').map(JSON.parse);
const G = Object.fromEntries(gold.map(g=>[g.id,g]));

// GOAL_NONE = absence of a stated goal, never a feasibility blocker -> universally supported.
const UNIVERSAL = ['GOAL_NONE'];

const A1 = { id:'collect_unlock',
  supported:['GOAL_COLLECT_N','GOAL_DELIVER','GOAL_REACH','ACT_PLAYER_DIRECT','ACT_AUTONOMOUS','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','REQ_TEXT_RENDER','IN_CLICK','IN_MOVE'],
  forbidden:['STATE_QUEUE','STATE_CONTINUOUS','STATE_PERSISTENT_MEMORY','STATE_INVENTORY','REQ_MULTI_SOURCE_INPUT','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_DIALOGUE','REQ_MULTI_AGENT','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_BEHAVIOUR_EDIT'] };

const A2 = { id:'sort_match',
  supported:['GOAL_ARRANGE','GOAL_SEQUENCE','ACT_PLAYER_DIRECT','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','STATE_INVENTORY','REQ_TEXT_RENDER','IN_CLICK','IN_DRAG'],
  forbidden:['STATE_QUEUE','STATE_CONTINUOUS','STATE_PERSISTENT_MEMORY','REQ_MULTI_SOURCE_INPUT','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_DIALOGUE','REQ_MULTI_AGENT','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_PATHFIND_GRID','REQ_BEHAVIOUR_EDIT'] };

const A3 = { id:'guide_avoid',
  supported:['GOAL_REACH','GOAL_SURVIVE_T','ACT_PLAYER_INDIRECT','ACT_AUTONOMOUS','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','REQ_PATHFIND_GRID','REQ_TEXT_RENDER','IN_CLICK','IN_DRAG'],
  forbidden:['STATE_QUEUE','STATE_CONTINUOUS','STATE_PERSISTENT_MEMORY','STATE_INVENTORY','REQ_MULTI_SOURCE_INPUT','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_DIALOGUE','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_BEHAVIOUR_EDIT','IN_AIM'] };

// candidate 4th archetypes
const C_TRIGGER = { id:'trigger_chain',
  supported:['GOAL_SEQUENCE','GOAL_THRESHOLD','ACT_PLAYER_DIRECT','ACT_AUTONOMOUS','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','STATE_QUEUE','REQ_MULTI_SOURCE_INPUT','REQ_TEXT_RENDER','IN_CLICK'],
  forbidden:['STATE_CONTINUOUS','STATE_PERSISTENT_MEMORY','STATE_INVENTORY','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_DIALOGUE','REQ_MULTI_AGENT','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_BEHAVIOUR_EDIT'] };

const C_TEND = { id:'tend_grow',
  supported:['GOAL_THRESHOLD','GOAL_COLLECT_N','ACT_PLAYER_DIRECT','ACT_AUTONOMOUS','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','STATE_PERSISTENT_MEMORY','REQ_MULTI_SOURCE_INPUT','REQ_TEXT_RENDER','IN_CLICK'],
  forbidden:['STATE_CONTINUOUS','STATE_QUEUE','STATE_INVENTORY','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_DIALOGUE','REQ_MULTI_AGENT','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_BEHAVIOUR_EDIT'] };

const C_RHYTHM = { id:'timing_rhythm',
  supported:['GOAL_THRESHOLD','GOAL_SURVIVE_T','ACT_PLAYER_DIRECT','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','REQ_TEXT_RENDER','IN_TIMED','IN_CLICK','IN_AIM'],
  forbidden:['STATE_CONTINUOUS','STATE_QUEUE','STATE_PERSISTENT_MEMORY','STATE_INVENTORY','REQ_MULTI_SOURCE_INPUT','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_DIALOGUE','REQ_MULTI_AGENT','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_BEHAVIOUR_EDIT'] };

const C_AGENTS = { id:'agent_ensemble',
  supported:['GOAL_NONE','GOAL_SURVIVE_T','ACT_AUTONOMOUS','ACT_PLAYER_DIRECT','STATE_DISCRETE','STATE_COUNTER','STATE_TIMER','REQ_MULTI_AGENT','REQ_PATHFIND_GRID','REQ_TEXT_RENDER','IN_CLICK','IN_MOVE'],
  forbidden:['STATE_CONTINUOUS','STATE_QUEUE','STATE_PERSISTENT_MEMORY','STATE_INVENTORY','REQ_MULTI_SOURCE_INPUT','REQ_DATA_BINDING','REQ_PHYSICS_SIM','REQ_FREEFORM_BUILD','REQ_NARRATIVE','REQ_PATHFIND_FREE','REQ_BEHAVIOUR_EDIT'] };

function feasible(a, req){
  for (const t of req){
    if (UNIVERSAL.includes(t)) continue;
    if (a.forbidden.includes(t)) return false;
    if (!a.supported.includes(t)) return false;
  }
  return true;
}
function blockers(a, req){
  return req.filter(t => !UNIVERSAL.includes(t) && (a.forbidden.includes(t) || !a.supported.includes(t)));
}
function evaluate(lib){
  const res = {};
  for (const p of prompts){
    const req = G[p.id].required;
    const F = lib.filter(a => feasible(a, req));
    res[p.id] = { label: F.length ? 'FULL':'NO_FIT', F: F.map(a=>a.id), req };
  }
  return res;
}
function pct(n,d){ return d ? (100*n/d).toFixed(1)+'%' : 'n/a'; }

// --- Effective requirements -------------------------------------------------
// feasible() skips UNIVERSAL tokens, so a prompt whose requirement set is empty
// after removing them imposes NO capability demand -- it passes any library
// vacuously (the for-loop never runs). Counting those as coverage inflates the
// headline: it scores graceful fallback as if it were fulfilment.
//   REQ    = prompts that actually demand a capability -> the coverage denominator
//   NO_REQ = vague / contradictory / nonsense / hostile / perf -> robustness set
function effReq(id){ return G[id].required.filter(t => !UNIVERSAL.includes(t)); }
const REQ    = prompts.filter(p => effReq(p.id).length > 0);
const NO_REQ = prompts.filter(p => effReq(p.id).length === 0);

function report(lib, title){
  const r = evaluate(lib);
  const fulfilled = REQ.filter(p => r[p.id].label === 'FULL');
  console.log(`\n=== ${title} ===`);
  console.log(`FULFILLED  ${fulfilled.length}/${REQ.length} = ${pct(fulfilled.length,REQ.length)}   <- headline, prompts with a real capability requirement`);
  console.log(`ROBUST     ${NO_REQ.length}/${NO_REQ.length} = 100.0%   <- no capability requirement; measures graceful handling, NOT coverage`);
  console.log(`(legacy combined figure: ${fulfilled.length+NO_REQ.length}/116 = ${pct(fulfilled.length+NO_REQ.length,116)} -- do not quote this)`);
  return r;
}

const LIB3 = [A1,A2,A3];
const r3 = report(LIB3, '3 archetypes (spike library)');
const full3 = prompts.filter(p=>r3[p.id].label==='FULL');

// by bucket -- denominator is prompts WITH a requirement; no-requirement buckets
// are shown as robustness sets so a 100 % there can never be read as coverage.
console.log(`\n-- by bucket (FULFILLED / prompts with a requirement) --`);
const buckets = [...new Set(prompts.map(p=>p.bucket))];
for (const b of buckets){
  const ps = prompts.filter(p=>p.bucket===b && effReq(p.id).length>0);
  const nr = prompts.filter(p=>p.bucket===b && effReq(p.id).length===0).length;
  if (!ps.length){ console.log(`${b.padEnd(18)}   -- robustness only (${nr} prompts, no capability requirement)`); continue; }
  const f = ps.filter(p=>r3[p.id].label==='FULL').length;
  console.log(`${b.padEnd(18)} ${String(f).padStart(3)}/${String(ps.length).padStart(3)}  ${pct(f,ps.length).padStart(6)}${nr?`   (+${nr} robustness)`:''}`);
}
// by split
console.log(`\n-- by split (FULFILLED / prompts with a requirement) --`);
for (const s of ['dev','holdout','reserve']){
  const ps = prompts.filter(p=>p.split===s && effReq(p.id).length>0);
  const nr = prompts.filter(p=>p.split===s && effReq(p.id).length===0).length;
  const f = ps.filter(p=>r3[p.id].label==='FULL').length;
  console.log(`${s.padEnd(10)} ${String(f).padStart(3)}/${String(ps.length).padStart(3)}  ${pct(f,ps.length).padStart(6)}${nr?`   (+${nr} robustness)`:''}`);
}

// which token blocks most often (min blockers across library)
console.log(`\n-- blocking tokens on NO_FIT prompts (token appears in the minimal blocker set of the nearest archetype) --`);
const tally = {};
for (const p of prompts){
  if (r3[p.id].label !== 'NO_FIT') continue;
  const req = G[p.id].required;
  let best = null;
  for (const a of LIB3){ const b = blockers(a,req); if (!best || b.length < best.length) best = b; }
  for (const t of best) tally[t] = (tally[t]||0)+1;
}
Object.entries(tally).sort((a,b)=>b[1]-a[1]).forEach(([t,n])=>console.log(`${String(n).padStart(3)}  ${t}`));

// All library figures below use the FULFILLED denominator (prompts with a
// requirement), so the numbers are comparable and cannot be inflated.
const fulfilledCount = lib => { const r = evaluate(lib); return REQ.filter(p=>r[p.id].label==='FULL').length; };
const base = fulfilledCount(LIB3);

console.log(`\n=== 4th archetype: how many NO_FIT flip to FULFILLED ===`);
for (const c of [C_TRIGGER,C_TEND,C_RHYTHM,C_AGENTS]){
  const r4 = evaluate([...LIB3,c]);
  const f4 = REQ.filter(p=>r4[p.id].label==='FULL').length;
  const flipped = REQ.filter(p=>r3[p.id].label==='NO_FIT' && r4[p.id].label==='FULL').map(p=>p.id);
  console.log(`${c.id.padEnd(16)} ${f4}/${REQ.length} = ${pct(f4,REQ.length)}  (+${f4-base})  ${flipped.join(' ')}`);
}

console.log(`\n=== best additional pairs ===`);
const cands=[C_TRIGGER,C_TEND,C_RHYTHM,C_AGENTS];
for (let i=0;i<cands.length;i++) for (let j=i+1;j<cands.length;j++){
  const f = fulfilledCount([...LIB3,cands[i],cands[j]]);
  console.log(`${(cands[i].id+' + '+cands[j].id).padEnd(34)} ${f}/${REQ.length} = ${pct(f,REQ.length)}  (+${f-base})`);
}
const rAll = evaluate([...LIB3,...cands]);
const fAll = REQ.filter(p=>rAll[p.id].label==='FULL').length;
console.log(`\nall 7 archetypes: ${fAll}/${REQ.length} = ${pct(fAll,REQ.length)}  (+${fAll-base} over 3)`);
console.log(`  marginal value of archetypes 4-7: ${(100*(fAll-base)/REQ.length).toFixed(1)} percentage points`);
const stillNo = REQ.filter(p=>rAll[p.id].label==='NO_FIT');
console.log(`\nstructurally out of reach even at 7 archetypes (${stillNo.length}):`);
stillNo.forEach(p=>console.log(`  ${p.id} [${p.bucket}] ${effReq(p.id).join(',')}`));

// --- Generated markdown -----------------------------------------------------
// COVERAGE.md must never carry hand-typed percentages again: they drifted from
// this script (69,0 % quoted vs 71,6 % computed). Regenerate with `node evals/coverage.js`
// and paste, or reference this file directly.
const rows = [
  ['3 archetypy (spike)', base],
  ...cands.map(c => [`3 + ${c.id}`, fulfilledCount([...LIB3, c])]),
  ...(() => { const out=[]; for (let i=0;i<cands.length;i++) for (let j=i+1;j<cands.length;j++)
      out.push([`3 + ${cands[i].id} + ${cands[j].id}`, fulfilledCount([...LIB3,cands[i],cands[j]])]); return out; })(),
  ['všech 7 archetypů', fAll],
];
const md = [
  `<!-- GENEROVÁNO: node evals/coverage.js -- needitovat ručně -->`,
  ``,
  `**Jmenovatel je ${REQ.length} promptů se skutečným capability požadavkem, ne 116.**`,
  `Zbylých ${NO_REQ.length} (vague, contradictory, nonsense, hostile, perf) žádný požadavek neukládá –`,
  `projdou vakuově jakoukoli knihovnou, takže měří robustnost, ne pokrytí.`,
  ``,
  `| Knihovna | FULFILLED | % | vs 3 archetypy |`,
  `|---|---:|---:|---:|`,
  ...rows.map(([name,n]) => `| ${name} | ${n}/${REQ.length} | ${pct(n,REQ.length)} | ${n===base?'—':`+${(100*(n-base)/REQ.length).toFixed(1)} b.`} |`),
  ``,
  `Mimo dosah i při 7 archetypech: **${stillNo.length}** promptů (${stillNo.map(p=>p.id).join(', ')}).`,
  ``,
].join('\n');
fs.writeFileSync(P+'coverage-generated.md', md);
console.log(`\n[zapsáno] evals/coverage-generated.md`);
