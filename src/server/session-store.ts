import {closeSync,existsSync,fstatSync,fsyncSync,mkdirSync,openSync,readFileSync,readSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {blueprintSchema,semanticObjectSchema,worldBoundsSchema} from '@/worldstream/schema';
import {worldDocSchema,simHashOf} from '@/ir/worlddoc';
import {MAX_LOG_EVENTS,SESSION_EVENT_TYPES} from '@/worldstream/events';
import {MESH_FAILURES,MESH_RESOLUTIONS} from '@/worldstream/cache';
import {findBlueprintReferenceIssues} from '@/worldstream/references';
import {WORLDSTREAM_ASSETS} from '@/assets/catalog';

const uint=z.int().nonnegative(),id=z.string().min(1).max(128),hash=z.string().min(1).max(128);
const artifact=z.object({shapeId:id,contentHash:hash,resolution:z.union(MESH_RESOLUTIONS.map(n=>z.literal(n))),vertices:uint,triangles:uint,bounds:worldBoundsSchema,buildMs:z.number().finite().nonnegative()}).strict();
const state=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('planned')}).strict(),z.object({kind:z.literal('validating')}).strict(),
  ...(['coarse','revealing','refined'] as const).map(kind=>z.object({kind:z.literal(kind),artifact}).strict()),
  z.object({kind:z.literal('refining'),from:artifact}).strict(),
  z.object({kind:z.literal('failed'),reason:z.enum(MESH_FAILURES),retryable:z.boolean()}).strict(),
]);
export const ordinarySessionRecordSchema=z.object({
  owner:z.string().regex(/^proxy-owner:[a-f0-9]{64}$/),
  snapshot:z.object({sessionId:id,sessionSeed:uint.max(2_147_483_647),phase:z.enum(['accepted','intent','blueprint','world','complete','failed']),quality:z.enum(['full','balanced','safe']),sequence:uint,
    representations:z.array(z.object({stableId:id,revision:uint,state,object:semanticObjectSchema.optional()}).strict()).max(64),
    cache:z.object({sessionSeed:uint,entries:z.array(artifact).max(256)}).strict()}).strict(),
  blueprint:blueprintSchema.nullable(),
  comparisonOrigin:z.object({original:worldDocSchema,acceptedSimHash:hash,acceptedSimRevision:uint,stableId:id}).strict().nullable(),
  authoredWorldId:id.nullable(),fault:z.string().max(1024).nullable(),
  eventLog:z.object({sequence:uint,floor:uint,entries:z.array(z.object({subject:z.string().max(128),event:z.object({sessionId:id,sequence:uint.positive(),type:z.enum(SESSION_EVENT_TYPES),at:z.string().max(64),payload:z.unknown()}).strict()}).strict()).max(MAX_LOG_EVENTS)}).strict(),
  updatedAt:z.number().finite().nonnegative(),
}).strict().superRefine((record,ctx)=>{
  const reject=(message:string)=>ctx.addIssue({code:'custom',message});
  const {snapshot,eventLog,blueprint,comparisonOrigin}=record;
  if(snapshot.sequence!==eventLog.sequence||snapshot.sessionSeed!==snapshot.cache.sessionSeed)reject('Session/log identity mismatch');
  if(eventLog.floor>eventLog.sequence||eventLog.entries.length!==eventLog.sequence-eventLog.floor)reject('Event log gap');
  eventLog.entries.forEach(({event},i)=>{if(event.sessionId!==snapshot.sessionId||event.sequence!==eventLog.floor+i+1)reject('Event identity/sequence mismatch');});
  if(new Set(snapshot.representations.map(r=>r.stableId)).size!==snapshot.representations.length)reject('Duplicate representation identity');
  if(blueprint) {
    if(blueprint.sessionSeed!==snapshot.sessionSeed||blueprint.world.simHash!==simHashOf(blueprint.world))reject('Blueprint hash/seed mismatch');
    if(findBlueprintReferenceIssues(blueprint,WORLDSTREAM_ASSETS).length)reject('Invalid blueprint references');
    if(snapshot.representations.some(r=>!blueprint.objects.some(o=>o.stableId===r.stableId)))reject('Unknown representation identity');
  }
  if(comparisonOrigin&&(!blueprint||comparisonOrigin.original.simHash!==simHashOf(comparisonOrigin.original)||comparisonOrigin.acceptedSimHash!==blueprint.world.simHash||comparisonOrigin.acceptedSimRevision!==blueprint.world.simRevision||!blueprint.objects.some(o=>o.stableId===comparisonOrigin.stableId)))reject('Invalid comparison origin');
});
export type OrdinarySessionRecord=z.infer<typeof ordinarySessionRecordSchema>;
const envelope=z.object({format:z.literal('ordinary-sessions-v1'),version:uint,records:z.array(ordinarySessionRecordSchema).max(64)}).strict().superRefine((value,ctx)=>{
  if(new Set(value.records.map(record=>record.snapshot.sessionId)).size!==value.records.length)ctx.addIssue({code:'custom',message:'Duplicate session identity'});
});
export interface OrdinarySessionStore {load():{version:number;records:OrdinarySessionRecord[]};save(records:readonly OrdinarySessionRecord[],expectedVersion:number):number;close():void}
export class SessionStoreError extends Error {constructor(){super('Durable session storage is unavailable');this.name='SessionStoreError';}}

/** Explicit single-process file checkpoint. No provider calls, credentials or hidden env lookup. */
export function openOrdinarySessionStore(file:string,options:{maxBytes?:number}={}):OrdinarySessionStore {
  if(!isAbsolute(file))throw new SessionStoreError();
  const target=resolve(file),maxBytes=options.maxBytes??32*1024**2;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>32*1024**2)throw new SessionStoreError();
  mkdirSync(dirname(target),{recursive:true});
  const lockPath=`${target}.lock`,token=randomUUID(),lock=openSync(lockPath,'wx',0o600);
  try{writeFileSync(lock,JSON.stringify({pid:process.pid,token}));fsyncSync(lock);}finally{closeSync(lock);}
  let closed=false,poisoned=false;
  const guard=()=>{if(closed||poisoned||JSON.parse(readFileSync(lockPath,'utf8')).token!==token)throw new SessionStoreError();};
  const protectedCall=<T>(action:()=>T):T=>{try{return action();}catch{poisoned=true;throw new SessionStoreError();}};
  const load=()=>protectedCall(()=>{
    guard();if(!existsSync(target))return {version:0,records:[]};
    const fd=openSync(target,'r');
    try {
      const size=fstatSync(fd).size;if(size<=0||size>maxBytes)throw new SessionStoreError();
      const bytes=Buffer.alloc(size+1);let count=0;
      while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
      if(count!==size)throw new SessionStoreError();
      const parsed=envelope.parse(JSON.parse(bytes.subarray(0,size).toString('utf8')));return {version:parsed.version,records:parsed.records};
    }finally{closeSync(fd);}
  });
  return {load,save:(records,expectedVersion)=>protectedCall(()=>{
    guard();if(load().version!==expectedVersion||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=Number.MAX_SAFE_INTEGER)throw new SessionStoreError();
    const version=expectedVersion+1,serialized=JSON.stringify(envelope.parse({format:'ordinary-sessions-v1',version,records}));
    if(Buffer.byteLength(serialized)>maxBytes)throw new SessionStoreError();
    const temporary=`${target}.${token}.tmp`,fd=openSync(temporary,'wx',0o600);
    try{writeFileSync(fd,serialized);fsyncSync(fd);}finally{closeSync(fd);}
    try{renameSync(temporary,target);}catch(error){try{unlinkSync(temporary);}catch{}throw error;}
    if(process.platform!=='win32'){const directory=openSync(dirname(target),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
    return version;
  }),close(){if(closed)return;closed=true;if(existsSync(lockPath)&&JSON.parse(readFileSync(lockPath,'utf8')).token===token)unlinkSync(lockPath);}};
}
