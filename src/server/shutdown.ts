/** Shared across route bundles. Drains transport only; Next owns process exit. */
type DrainState={draining:boolean;streams:Set<()=>void>;installed:boolean};
const host=globalThis as typeof globalThis & {__worldstreamDrain?:DrainState};
const state=host.__worldstreamDrain??(host.__worldstreamDrain={draining:false,streams:new Set(),installed:false});
export function beginServerDrain():void {
  if(state.draining)return;state.draining=true;
  const streams=[...state.streams];state.streams.clear();
  for(const close of streams){try{close();}catch{/* One disconnected controller must not block the rest. */}}
}
export function serverIsDraining():boolean{return state.draining;}
export function registerStreamDrain(close:()=>void):()=>void {
  if(!state.installed){state.installed=true;process.on('SIGTERM',beginServerDrain);process.on('SIGINT',beginServerDrain);}
  if(state.draining){close();return()=>{};}
  state.streams.add(close);return()=>{state.streams.delete(close);};
}
export function resetServerDrainForTests():void{beginServerDrain();state.draining=false;}
export function activeDrainStreamsForTests():number{return state.streams.size;}
