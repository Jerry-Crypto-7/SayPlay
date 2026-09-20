'use client';
import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import catalog from '@/assets/catalog.json';
import {blueprintSchema} from '@/worldstream/schema';
import {buildProxyWorldFrom,type ProxyWorld} from '@/worldstream/proxy';
import {createRuntimeController} from '@/worldstream/runtime-controller';
import {buildRuntimeWorld} from '@/ir/build';
import {sealSimHash} from '@/ir/worlddoc';
import WorldstreamCanvas from '@/components/worldstream/WorldstreamCanvas';
import {DEMO_BLUEPRINT} from '../demo-world';

const sim={...DEMO_BLUEPRINT.world.sim,rules:{switch:{phase:0,priority:0,event:{kind:'onAction',actionId:'switch',target:'tallHive'},condition:null,actions:[{kind:'setFlag',flag:'hiveCalm',value:true}]}}};
function controller() {const built=buildRuntimeWorld(sim);if(!built.ok)throw new Error(built.issues.join(';'));return createRuntimeController({...built.world,trace:[]});}

/** Explicit manual lifetime fixture. Never used by generation. */
export default function AssetHotSwap() {
  const [runtime]=useState(controller),state=useSyncExternalStore(runtime.subscribe,runtime.getSnapshot,runtime.getSnapshot);
  const [base,setBase]=useState<ProxyWorld|null>(null),[level,setLevel]=useState(0),[count,setCount]=useState(5),[adaptive,setAdaptive]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [zoneMode,setZoneMode]=useState(false),[zone,setZone]=useState(0);
  useEffect(()=>{
    let active=true;
    const streaming=new URLSearchParams(window.location.search).has('zones');
    if(streaming){setZoneMode(true);setCount(6);setAdaptive(true);}
    const objects=Array.from({length:streaming?6:5},(_,i)=>{const x=streaming?(Math.floor(i/2)-1)*56+(i%2)*2:(i-2)*1.7;
      const asset=catalog.assets.find(a=>a.assetId===(streaming?['lounge-chair','potted-plant','desktop-terminal'][Math.floor(i/2)]:'seated-person'))!;
      return {stableId:`listener${i+1}`,label:`Listener ${i+1}`,synonyms:[],role:'prop',importance:2,yaw:(i-2)*Math.PI/6,
      source:{kind:'asset',assetId:asset.assetId,version:asset.version,hash:asset.hash},targetBounds:{min:[x-0.7,0,-0.7],max:[x+0.7,2,0.7]},
      binding:{...(!streaming&&i===0?{entityId:'keeper',signalFlag:'hiveCalm'}:{}),collider:{min:[x-0.7,0,-0.7],max:[x+0.7,2,0.7]},sockets:[],parts:[]}};});
    const blueprint=blueprintSchema.parse({...DEMO_BLUEPRINT,version:'worldstream-v2',world:sealSimHash({...DEMO_BLUEPRINT.world,sim}),objects,shapes:[],geometry:{version:DEMO_BLUEPRINT.geometry.version,nodes:[{kind:'terrain',variant:'plateau',extent:[12,6],amplitude:0,seed:1}],root:0}});
    void buildProxyWorldFrom(blueprint,{mesh:async()=>{throw new Error('No shapes in asset lifetime fixture');}}).then(world=>{if(active)setBase(world);}).catch(reason=>{if(active)setError(String(reason));});
    return ()=>{active=false;};
  },[]);
  const world=useMemo(()=>base?.kind==='built'?{...base,slots:base.slots.slice(0,count).map(entry=>entry.form.kind==='asset'?{...entry,form:{...entry.form,level}}:entry)}:base,[base,count,level]);
  return <main style={{height:'100vh'}}>
    <WorldstreamCanvas world={world} controller={runtime} adaptiveAssets={adaptive} sceneId="asset-lifetime-fixture" focusId={zoneMode?`listener${zone*2+1}`:undefined}/>
    <section style={{position:'absolute',top:16,left:16,padding:12,background:'#14232e',zIndex:10}}>
      <strong>Manual asset lifetime fixture · five independent listeners</strong>
      <p data-testid="runtime-state">{JSON.stringify({tick:state.tick,stateHash:state.stateHash,flag:state.values['f:hiveCalm']})}</p>
      <button onClick={()=>runtime.dispatch(runtime.actions[0])}>Interact</button>{' '}
      <button onClick={()=>runtime.observeAt(0)}>Rewind</button>{' '}
      <button onClick={()=>setLevel(value=>1-value)}>LOD {level}</button>{' '}
      <button onClick={()=>setCount(value=>value===5?4:5)}>Toggle fifth listener</button>{' '}
      <button onClick={()=>setAdaptive(value=>!value)}>Adaptive {adaptive?'on':'off'}</button>
      {zoneMode&&<p>Manual three-zone streaming fixture. {[0,1,2].map(index=><button key={index} onClick={()=>setZone(index)}>Zone {index+1}</button>)}</p>}
      {error&&<p role="alert">{error}</p>}
    </section>
  </main>;
}
