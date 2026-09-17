export const ZONE_STREAM_POLICY={cellSize:24,retainDistance:48,resumeDistance:36,hiddenSeconds:5,intervalSeconds:0.25} as const;
export function zoneKey(point:readonly number[]):string {
  return `${Math.floor(point[0]/ZONE_STREAM_POLICY.cellSize)}:${Math.floor(point[2]/ZONE_STREAM_POLICY.cellSize)}`;
}
/** Presentation clock only. No world state, semantic IDs or runtime ticks are modified. */
export function createZoneTracker() {
  const hiddenSince=new Map<string,number>();
  return {
    decide(input:{id:string;importance:number;distance:number;inFrame:boolean;suspended:boolean;now:number}):'retain'|'suspend'|'resume' {
      const {id,importance,distance,inFrame,suspended,now}=input;
      if(importance>=3||inFrame||distance<=ZONE_STREAM_POLICY.resumeDistance) {
        hiddenSince.delete(id);return suspended?'resume':'retain';
      }
      if(suspended)return 'retain';
      if(distance<=ZONE_STREAM_POLICY.retainDistance){hiddenSince.delete(id);return 'retain';}
      const since=hiddenSince.get(id)??now;hiddenSince.set(id,since);
      return now-since>=ZONE_STREAM_POLICY.hiddenSeconds?'suspend':'retain';
    },
    prune(ids:ReadonlySet<string>){for(const id of hiddenSince.keys())if(!ids.has(id))hiddenSince.delete(id);},
  };
}
