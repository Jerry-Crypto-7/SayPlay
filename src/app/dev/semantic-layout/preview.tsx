'use client';
import {useEffect,useState} from 'react';
import WorldstreamCanvas from '@/components/worldstream/WorldstreamCanvas';
import {buildProxyWorldFrom,type ProxyWorld} from '@/worldstream/proxy';
import type {WorldstreamBlueprint} from '@/worldstream/schema';

export default function SemanticLayoutPreview({blueprint,adjustments}:{blueprint:WorldstreamBlueprint;adjustments:readonly string[]}) {
  const [world,setWorld]=useState<ProxyWorld|null>(null),[error,setError]=useState<string|null>(null);
  const [cutaway,setCutaway]=useState(true);
  useEffect(()=>{let active=true;
    void buildProxyWorldFrom(blueprint,{mesh:async()=>{throw new Error('Unexpected shape in semantic layout fixture');}}).then(built=>{if(active)setWorld(built);}).catch(reason=>{if(active)setError(String(reason));});
    return ()=>{active=false;};
  },[blueprint]);
  return <main style={{height:'100vh'}}>
    <WorldstreamCanvas world={world} adaptiveAssets={false} cutaway={cutaway}/>
    <section style={{position:'absolute',top:12,left:12,maxWidth:480,padding:12,background:'#14232e',color:'#edf0ec',zIndex:10}}>
      <strong>Compiler layout fixture · not live generation</strong>
      <p>Three seated listeners face the aquarium. A plant contacts the sampled sloped terrace.</p>
      <button onClick={()=>setCutaway(value=>!value)}>{cutaway?'Show full walls':'Cut away walls'}</button>
      <output data-testid="layout-report">{JSON.stringify({objects:blueprint.objects.length,contacts:blueprint.sceneSpec?.relations.filter(r=>r.relation==='on').length,facing:blueprint.sceneSpec?.relations.filter(r=>r.relation==='facing').length,adjustments})}</output>
      {error&&<p role="alert">{error}</p>}
    </section>
  </main>;
}
