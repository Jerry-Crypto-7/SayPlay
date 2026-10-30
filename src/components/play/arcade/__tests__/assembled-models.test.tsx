import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { PerspectiveCamera } from 'three';
import { expect, it, vi } from 'vitest';
import { ROLE } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { LOOKS, LOOK_IDS } from '@/play/arcade/look';
import { hasBlaster } from '../ArcadeStage';
import { modelIdOf, FittedModel } from '../World';
import { ArenaWorld } from '../arena/ArenaScene';
import { BALL_SCENE_KINDS, ballLaunchRule } from '../ball/BallScene';
import { drawsNothing } from '../bodies';
import type { ArcadeSession } from '../session';

vi.mock('react', async original => ({...(await original<typeof import('react')>()),
 useState:(v:unknown)=>[typeof v==='function'?(v as ()=>unknown)():v,()=>undefined], useMemo:(f:()=>unknown)=>f(),useRef:(v:unknown)=>({current:v}),useEffect:()=>undefined,
 useSyncExternalStore:(_s:unknown,s:()=>unknown)=>s(),useContext:(c:{_currentValue:unknown})=>c._currentValue,
}));
vi.mock('@react-three/fiber',async original=>({...await original<typeof import('@react-three/fiber')>(),useFrame:()=>undefined,useThree:(f:(v:{camera:PerspectiveCamera})=>unknown)=>f({camera:new PerspectiveCamera()})}));
const cast={player:'fox',enemy:'robot',chaser:'bear',props:{},things:{part_0:'fish'}};
it('shared world resolves custom part role codes and the named ball forward',()=>{
 const view={index:1,kind:'thing:part_0',role:128,w:1,h:1,d:1};
 expect(drawsNothing(view)).toBe(false);
 expect(modelIdOf(view,cast)).toBe('fish');
 expect(modelIdOf({...view,kind:'opponent-forward',role:ROLE.enemy},cast)).toBe('robot');
 expect(BALL_SCENE_KINDS.has('opponent-ball')).toBe(true);
 expect(BALL_SCENE_KINDS.has('home-goal')).toBe(true);
 expect(BALL_SCENE_KINDS.has('opponent-forward')).toBe(false);
});
const find=(node:ReactNode): ReactElement<Record<string,unknown>>[]=>Array.isArray(node)?node.flatMap(find):isValidElement(node)?[node as ReactElement<Record<string,unknown>>,...find((node.props as {children?:ReactNode}).children)]:[];
it('arena renders the sentence model for a custom assembly part instead of an anonymous block',()=>{
 const made=buildWorld({seed:1,control:{id:'move_free',params:{half:20000}},bot:{id:'arena_bot',params:{}},rules:[],level:{length:0,bodies:[
 {role:'player',kind:'player',x:0,y:0,z:0,w:1000,h:1000,d:1000,solid:false},
 {role:'thing',roleCode:128,kind:'thing:part_0',x:2000,y:0,z:0,w:600,h:600,d:600,solid:false},
 ]}},ARCADE_LIBRARY);
 if(!made.ok)throw new Error(made.issues.join('; '));
 const session={world:made.world,state:()=>instantiate(made.world),snapshot:()=>({tick:0,runState:'running'}),subscribe:()=>()=>undefined,paused:()=>false} as unknown as ArcadeSession;
 const host=ArenaWorld({session,half:20000,surface:{current:null},look:LOOKS[LOOK_IDS[0]],cast,heroAction:'none'});
 const tree=(host.type as (props:unknown)=>ReactNode)(host.props);
 expect(find(tree).filter(n=>n.type===FittedModel).map(n=>n.props.id)).toContain('fish');
});

it.each(['goal','hoop','hole'])('assembly gates preserve the %s aiming trajectory and ball template', goal=>{
 const launch={id:'ball_launch',params:{goal,template:7}};
 const unrelated={id:'time_limit',params:{seconds:35}};
 expect(ballLaunchRule([unrelated,launch])).toBe(launch);
 expect(ballLaunchRule([unrelated,{id:'assembly_gate_tick',params:{base:launch}}])).toBe(launch);
 expect(ballLaunchRule([{id:'assembly_gate_press',params:{base:{id:'assembly_gate_tick',params:{base:launch}}}}])).toBe(launch);
 expect(ballLaunchRule([unrelated])).toBeUndefined();
});

it('fire input and button detect a blaster through nested assembly gates',()=>{
 const blaster={id:'blaster',params:{}};
 expect(hasBlaster([blaster])).toBe(true);
 expect(hasBlaster([{id:'assembly_gate_press',params:{base:{id:'assembly_gate_tick',params:{base:blaster}}}}])).toBe(true);
 expect(hasBlaster([{id:'assembly_gate_press',params:{base:{id:'ball_launch',params:{}}}}])).toBe(false);
});
