'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { type InstancedMesh, Object3D } from 'three';
import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { baseControlOf } from '@/play/arcade/addons';
import type { ArcadeSession } from '../session';
import { renderHeld } from './render-feel';
import { skidStrength, threatTelegraphs } from './feel';

/** Two instanced draws; all geometry is an observation of actual bodies, no game state writes. */
export function FeelCues({session}:{readonly session:ArcadeSession}) {
  const warnings=useRef<InstancedMesh>(null), skids=useRef<InstancedMesh>(null);
  const pose=useMemo(()=>new Object3D(),[]);
  const trail=useRef<{x:number;y:number;z:number;strength:number;tick:number}[]>([]);
  const last=useRef(-1);
  const control=baseControlOf(session.world.control).id;
  useFrame(({camera})=>{
    if(renderHeld(session)) return;
    const state=session.state(),tick=state[HEADER.tick]!;
    if(tick<last.current) trail.current=[];
    if(warnings.current!==null) {
      const cues=threatTelegraphs(state,session.world);warnings.current.count=cues.length;
      cues.forEach((cue,i)=>{
        pose.position.set(-cue.x/UNIT, cue.y/UNIT+0.7, cue.z/UNIT);
        pose.quaternion.copy(camera.quaternion);
        pose.scale.setScalar(Math.max(0.55,cue.radius/UNIT)*(0.8+cue.urgency*0.2));
        pose.updateMatrix();warnings.current!.setMatrixAt(i,pose.matrix);
      });
      warnings.current.instanceMatrix.needsUpdate=true;
    }
    const p=bodyBase(state[HEADER.player]!);
    const strength=skidStrength(state[p+BODY.vx]!,state[p+BODY.vz]!,state[p+BODY.y]!<80 || !!(state[p+BODY.flags]!&FLAG.grounded));
    if(control==='steer' && tick!==last.current && strength>0) {
      trail.current.push({x:-state[p+BODY.x]!/UNIT,y:0.025,z:state[p+BODY.z]!/UNIT,strength,tick});
    }
    last.current=tick;
    trail.current=trail.current.filter(point=>tick-point.tick<60).slice(-32);
    if(skids.current!==null){
      skids.current.count=trail.current.length*2;
      trail.current.forEach((point,i)=>{
        for(let wheel=0;wheel<2;wheel++){
          pose.position.set(point.x+(wheel===0?-0.35:0.35),point.y,point.z);
          pose.rotation.set(-Math.PI/2,0,0);
          pose.scale.set(0.08+point.strength*0.08,0.5,1);pose.updateMatrix();
          skids.current!.setMatrixAt(i*2+wheel,pose.matrix);
        }
      });skids.current.instanceMatrix.needsUpdate=true;
    }
  });
  return <>
    <instancedMesh ref={warnings} args={[undefined,undefined,16]} frustumCulled={false} renderOrder={4}>
      <ringGeometry args={[0.9,1,24]} /><meshBasicMaterial color={color.tomato} transparent opacity={0.75} depthWrite={false} />
    </instancedMesh>
    <instancedMesh ref={skids} args={[undefined,undefined,64]} frustumCulled={false}>
      <planeGeometry args={[1,1]} /><meshBasicMaterial color={color.ink} transparent opacity={0.5} depthWrite={false} />
    </instancedMesh>
  </>;
}
