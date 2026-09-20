import type {PlannerEmission} from '@/model/worldstream-intent';
import {representationCandidates} from '@/assets/resolver';
import {WORLDSTREAM_ASSETS} from '@/assets/catalog';
import type {AssetManifest} from '@/assets/manifest';
import type {AssetRecord} from '@/assets/schema';
import {rotateY,transformBounds,transformPoint,transformNormal} from '@/assets/transform';
import {GEOM_VERSION,type GeomNode,type GeomProgram} from '@/geom/program';
import type {Bounds3,Vec3} from '@/shape/types';
import {visualPreviewSchema,type VisualPreview,type SemanticObject} from '@/worldstream/schema';
import {readSceneSpec} from './spec';
import {lowerArchitecture} from './architecture';
import {measureLayout} from './layout';
import {validateLayout} from './constraints';

export type IntentPreviewResult={ok:true;preview:VisualPreview;provisional:true}|{ok:false;reason:string;details:readonly string[]};
const vec=(x:number,y:number,z:number):[number,number,number]=>[x,y,z];
const mutable=(p:Vec3)=>vec(p[0],p[1],p[2]);
const one=vec(1,1,1);
const center=(b:Bounds3)=>vec((b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2);

/** A bounded, provisional disposition of this exact plan, never a WorldDoc or
 * a replacement reference scene. Unsupported relations fail closed. No network.
 *
 * ⚠ **Tohle je výjimečný případ, ne fáze hlavní cesty – rozhodnuto 18. 9. 2026
 * (P20 F1).** Nad 18 archivovanými plány série T18 projde tímhle profilem
 * **jeden**. Devět padá na mezi „nejvýš jedna místnost a jeden terén", jenže
 * hned za ní stojí slovník: zvednout jen ten strop pustí dál **nula** dalších
 * plánů, zvednout strop i oba slovníky pustí **jeden**, protože pod tím leží
 * stěna relačních mezí (sedm plánů má řetězec `connected-to`, tři nesplněnou
 * relaci, dva `facing`, dva kontejner).
 *
 * Rozšíření profilu tedy není doladění dvou kontrol, je to přepsání relačního
 * layoutu za měřených +1 z 18 – a proto se **nedělá**. Kdo sem sáhne s úmyslem
 * pustit dál víc plánů, ať to nejdřív změří nad těmi samými 18 plány; bez toho
 * měření se rozšíření necommituje.
 *
 * Následek pro texty: náhled se nikde nesmí popisovat jako pokrytá fáze cesty
 * porotce (`plans/P20/t16-progressive.md`, `docs/demo/judge-runbook.md`).
 */
export function buildIntentPreview(plan:PlannerEmission,options:{sessionSeed:number;assets?:AssetManifest}):IntentPreviewResult {
  const fail=(reason:string,...details:string[]):IntentPreviewResult=>({ok:false,reason,details});
  const assets=options.assets??WORLDSTREAM_ASSETS;
  const spec=readSceneSpec(plan.sceneSpec,plan.objects.map(o=>o.stableId));
  if(typeof spec==='string')return fail('INVALID_SCENE_SPEC',spec);
  if(plan.objects.some(o=>spec.instances.find(i=>i.stableId===o.stableId)?.role!==o.role))return fail('CONTRADICTORY_ROLE','SceneSpec and planned object roles disagree.');
  if(plan.objects.length>24)return fail('LAYOUT_BUDGET','At most 24 planned identities are supported.');
  const architecture=plan.objects.filter(o=>o.role==='architecture'),terrain=plan.objects.filter(o=>o.role==='terrain');
  if(architecture.length>1||terrain.length>1)return fail('UNSUPPORTED_ENCLOSURE','At most one room and one flat terrain.');
  if(architecture.some(o=>!(/\b(room|hall|corridor|interior|reading room)\b/i.test([o.label,...o.synonyms].join(' ')))))
    return fail('UNSUPPORTED_ARCHITECTURE','Only an explicitly named room, hall or corridor can be approximated by a rectangular enclosure.');
  if(terrain.some(o=>!(/\b(flat|ground|floor|courtyard|lawn|plateau)\b/i.test([o.label,...o.synonyms].join(' ')))))
    return fail('UNSUPPORTED_TERRAIN','Only a named flat ground surface is supported.');
  const enclosure=architecture[0]?.stableId,ground=terrain[0]?.stableId;
  const physical=plan.objects.filter(o=>o.role!=='architecture'&&o.role!=='terrain');
  const relationParents=new Map<string,string>(),facing=new Map<string,string>();
  const connections=new Map<string,string>();
  for(const relation of spec.relations){
    const {subjectId,targetId}=relation;
    if(relation.relation==='against')return fail('UNSUPPORTED_RELATION',`${subjectId} ${relation.relation} ${targetId}`);
    if(relation.relation==='connected-to'){
      // Only disjoint physical pairs. Chains, cycles and duplicate reverse
      // declarations are deliberately outside this provisional layout profile.
      if(subjectId===targetId||!physical.some(o=>o.stableId===subjectId)||!physical.some(o=>o.stableId===targetId)
        ||connections.has(subjectId)||connections.has(targetId))return fail('UNSUPPORTED_CONNECTION',`${subjectId} connected-to ${targetId}: only disjoint physical pairs are supported.`);
      connections.set(subjectId,targetId);connections.set(targetId,subjectId);
    }
    if(relation.relation==='inside'&&(targetId!==enclosure||subjectId===ground))return fail('UNSUPPORTED_CONTAINER',`${subjectId} inside ${targetId}`);
    if(relation.relation==='on'){
      if(subjectId===enclosure||subjectId===ground||targetId===enclosure)return fail('UNSUPPORTED_SUPPORT',`${subjectId} on ${targetId}`);
      if(relationParents.has(subjectId)&&relationParents.get(subjectId)!==targetId)return fail('CONTRADICTORY_SUPPORT',subjectId);
      relationParents.set(subjectId,targetId);
    }
    if(relation.relation==='facing'){
      if(facing.has(subjectId)&&facing.get(subjectId)!==targetId)return fail('CONTRADICTORY_FACING',subjectId);
      facing.set(subjectId,targetId);
    }
  }
  for(const id of connections.keys())if(relationParents.has(id)||[...relationParents.values()].includes(id)||facing.has(id))
    return fail('UNSUPPORTED_CONNECTION',`${id}: connected pairs cannot participate in support or have an outgoing facing constraint.`);
  // A support forest has bounded depth, and no implicit replacement identities.
  const roots=new Map<string,string>();
  for(const object of physical){
    const seen=new Set<string>();let id=object.stableId,depth=0;
    while(relationParents.has(id)&&relationParents.get(id)!==ground){
      if(seen.has(id))return fail('CYCLIC_SUPPORT',object.stableId);seen.add(id);
      if(++depth>4)return fail('SUPPORT_DEPTH',object.stableId);id=relationParents.get(id)!;
    }
    roots.set(object.stableId,id);
  }
  const selected=new Map<string,AssetRecord>(),limitations=[
    'Provisional planner layout only. No simulation, interaction, certificate or final compiler geometry.',
    'Catalog choices, dimensions, spacing, colors and unmodeled attributes are provisional; only the listed spatial relations are checked.',
  ];
  for(const object of physical){
    const candidate=representationCandidates(object,assets).candidates[0];
    if(candidate){const resolved=assets.resolve(candidate.source);if(!resolved.ok)return fail('ASSET_REFERENCE',resolved.reason);selected.set(object.stableId,resolved.asset);}
    else limitations.push(`${object.stableId}: explicit unit-block rough proxy; requested shape and appearance remain unresolved.`);
  }
  for(const id of facing.keys())if(!selected.has(id))return fail('UNSUPPORTED_FACING',`${id}: no approved forward frame.`);
  const rootIds=[...new Set(roots.values())].sort();
  const radii=physical.map(o=>{const b=selected.get(o.stableId)?.bounds;return b?Math.hypot(b.max[0]-b.min[0],b.max[2]-b.min[2]):Math.SQRT2;});
  const footprint=(id:string)=>{const b=selected.get(id)?.bounds;return b?vec(b.max[0]-b.min[0],b.max[1]-b.min[1],b.max[2]-b.min[2]):one;};
  const groups:string[][]=[];const grouped=new Set<string>();
  for(const id of rootIds){if(grouped.has(id))continue;const partner=connections.get(id);const ids=partner?[id,partner].sort():[id];groups.push(ids);ids.forEach(v=>grouped.add(v));}
  // Pair members retain their own IDs; only the grid allocation is grouped.
  // Reserve the entire natural-width pair before positioning unrelated roots.
  const pairWidths=groups.filter(g=>g.length===2).map(g=>footprint(g[0])[0]+footprint(g[1])[0]);
  const stride=Math.max(2,...radii,...pairWidths)+0.6,columns=Math.max(1,Math.ceil(Math.sqrt(groups.length))),rows=Math.max(1,Math.ceil(groups.length/columns));
  const width=Math.max(4,columns*stride+1.2),depth=Math.max(4,rows*stride+1.2);
  if(width>30||depth>30)return fail('LAYOUT_BUDGET','Natural object footprints exceed the 30m provisional layout.');
  const positions=new Map<string,Vec3>();
  groups.forEach((ids,i)=>{
    const x=(i%columns-(columns-1)/2)*stride,z=(Math.floor(i/columns)-(rows-1)/2)*stride;
    if(ids.length===1)positions.set(ids[0],vec(x,0,z));
    else{positions.set(ids[0],vec(x-footprint(ids[1])[0]/2,0,z));positions.set(ids[1],vec(x+footprint(ids[0])[0]/2,0,z));}
  });
  for(const object of physical)positions.set(object.stableId,positions.get(roots.get(object.stableId)!)!);
  if(enclosure)positions.set(enclosure,vec(0,0,0));if(ground)positions.set(ground,vec(0,0,0));
  const yaws=new Map<string,number>();
  for(const [id,target]of facing){const a=positions.get(id),b=positions.get(target);if(!a||!b||Math.hypot(b[0]-a[0],b[2]-a[2])<0.08)return fail('CONTRADICTORY_FACING',`${id} faces a coincident target.`);yaws.set(id,Math.atan2(b[0]-a[0],b[2]-a[2]));}
  const translations=new Map<string,Vec3>(),bounds=new Map<string,Bounds3>(),supportSockets=new Map<string,string>();
  const placed=new Set<string>();
  function place(id:string):string|null {
    if(placed.has(id))return null;
    const asset=selected.get(id),local=asset?.bounds??{min:vec(-0.5,0,-0.5),max:vec(0.5,1,0.5)},yaw=yaws.get(id)??0;
    const p=positions.get(id)!;const c=rotateY(center(local),yaw);
    let translation=vec(p[0]-c[0],-local.min[1],p[2]-c[2]);
    const parent=relationParents.get(id);
    if(parent&&parent!==ground){
      const failure=place(parent);if(failure)return failure;
      const support=selected.get(parent),surface=support?.supportSurfaces[0];
      if(!support||!surface)return `${parent}: no approved support surface.`;
      const parentTransform={scale:one,translation:translations.get(parent)!,rotationY:yaws.get(parent)??0};
      const at=transformPoint(parentTransform,surface.center),socket=asset?.sockets.find(s=>s.normal[1]<-0.5);
      if(socket){const rotated=rotateY(socket.at,yaw);translation=vec(at[0]-rotated[0],at[1]-rotated[1],at[2]-rotated[2]);supportSockets.set(id,socket.id);}
      else translation=vec(at[0]-c[0],at[1]-local.min[1],at[2]-c[2]);
    }
    translations.set(id,translation);bounds.set(id,transformBounds({scale:one,translation,rotationY:yaw},local));placed.add(id);return null;
  }
  for(const object of physical){const error=place(object.stableId);if(error)return fail('UNSUPPORTED_SUPPORT',error);}
  const height=Math.max(3.2,...[...bounds.values()].map(b=>b.max[1]+0.5));
  if(connections.size)limitations.push('Connected-to uses disjoint ground-level physical pairs with adjoining measured AABB faces; no cable, port, electrical behavior or arbitrary connection network is inferred.');
  if(height>12)return fail('LAYOUT_BUDGET','Stacked contents exceed the 12m room height.');
  const nodes:GeomNode[]=[],objects:SemanticObject[]=[],geometryRoots:number[]=[];
  if(enclosure){
    const lowered=lowerArchitecture([{stableId:enclosure,kind:'room',at:vec(0,0,0),width,depth,height,thickness:0.15,openings:[]}]);
    nodes.push(...lowered.nodes);const root=lowered.roots.get(enclosure)!;geometryRoots.push(root);
    objects.push({...architecture[0],synonyms:[...architecture[0].synonyms],source:{kind:'geom',node:root},targetBounds:{min:vec(-width/2-0.075,-0.15,-depth/2-0.075),max:vec(width/2+0.075,height,depth/2+0.075)}});
    limitations.push(`${enclosure}: provisional rectangular open-roof enclosure; openings and authored dimensions remain unresolved.`);
  }
  if(ground){const root=nodes.length;nodes.push({kind:'terrain',variant:'flat',extent:[width,depth],amplitude:0,seed:options.sessionSeed});geometryRoots.push(root);
    objects.push({...terrain[0],synonyms:[...terrain[0].synonyms],source:{kind:'geom',node:root},targetBounds:{min:vec(-width/2,-0.01,-depth/2),max:vec(width/2,0.01,depth/2)}});}
  for(const object of physical){
    const asset=selected.get(object.stableId),measuredBounds=bounds.get(object.stableId)!;
    const targetBounds={min:mutable(measuredBounds.min),max:mutable(measuredBounds.max)};
    if(asset){const transform={scale:one,translation:translations.get(object.stableId)!,rotationY:yaws.get(object.stableId)??0};
      objects.push({...object,synonyms:[...object.synonyms],source:{kind:'asset',assetId:asset.assetId,version:asset.version,hash:asset.hash},yaw:transform.rotationY,targetBounds,
        ...(supportSockets.has(object.stableId)?{supportSocket:supportSockets.get(object.stableId)}:{}),
        binding:{collider:targetBounds,sockets:asset.sockets.map(s=>({id:s.id,at:mutable(transformPoint(transform,s.at)),normal:mutable(transformNormal(transform,s.normal))})),parts:[]}});
    }else{const root=nodes.length;nodes.push({kind:'mass',variant:'block',at:center(targetBounds),scale:one});geometryRoots.push(root);
      objects.push({...object,synonyms:[...object.synonyms],source:{kind:'geom',node:root},targetBounds});}
  }
  // Do not manufacture invisible/dummy scenery to satisfy the geometry contract.
  if(!geometryRoots.length)return fail('UNSUPPORTED_ASSET_ONLY_LAYOUT','The current preview contract requires explicit room, terrain or rough geometry.');
  while(geometryRoots.length>16){const children=geometryRoots.splice(0,16),root=nodes.length;nodes.push({kind:'group',children});geometryRoots.push(root);}
  const root=nodes.length;nodes.push({kind:'group',children:geometryRoots});
  const geometry:GeomProgram={version:GEOM_VERSION,nodes,root};
  try {
    const measured=measureLayout(objects,geometry,assets),issues=validateLayout(spec,measured);
    if(issues.length)return fail('RELATION_UNSATISFIED',...issues.map(i=>`${i.subjectId}: ${i.detail}`));
    // Only an ancestor support contact may overlap. Two subjects sharing a
    // single support/socket are not licensed to occupy the same volume.
    const solids=measured.filter(b=>roots.has(b.stableId));
    const supports=(ancestor:string,child:string)=>{let id=relationParents.get(child);while(id){if(id===ancestor)return true;id=relationParents.get(id);}return false;};
    for(let i=0;i<solids.length;i++)for(let j=i+1;j<solids.length;j++){
      const a=solids[i],b=solids[j];if(supports(a.stableId,b.stableId)||supports(b.stableId,a.stableId))continue;
      if([0,1,2].every(axis=>Math.min(a.bounds.max[axis],b.bounds.max[axis])-Math.max(a.bounds.min[axis],b.bounds.min[axis])>0.08))return fail('OVERLAPPING_LAYOUT',`${a.stableId}/${b.stableId}`);
    }
    const parsed=visualPreviewSchema.safeParse({kind:'visual-preview',stage:'intent-layout',interactive:false,version:'worldstream-v2',sessionSeed:options.sessionSeed,
      title:plan.intent.setting.slice(0,120),intent:plan.intent,sceneSpec:spec,geometry,objects,shapes:[],
      look:{modules:{},palette:'sand',lightRig:'rim',atmosphere:'clear',materialRoles:{},camera:{},audio:{}},validation:{layout:'checked',limitations}});
    if(!parsed.success)return fail('PREVIEW_SCHEMA',...parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`));
    return {ok:true,preview:parsed.data,provisional:true};
  }catch(error){return fail('LAYOUT_INVALID',error instanceof Error?error.message:String(error));}
}
