"""Pure replay of retained candidate observations. No OS or source loading."""
import hashlib
import json
import math
import re

SOURCES=('subscription-candidate-resource-stress-observer.py','subscription-candidate-resource-events.py',
         'subscription-systemd-fixture-transport.py','subscription-systemd-cli-probe.py','subscription-candidate-resource-capacity.py')
FILES=('memory.max','memory.swap.max','pids.max','memory.oom.group','memory.events','memory.events.local',
       'pids.events','cgroup.events','memory.current','pids.current','cgroup.procs')
LIMITS={'memory.max':2147483648,'memory.swap.max':0,'pids.max':64,'memory.oom.group':0}
COUNTERS={'memory.events':('max','oom','oom_kill'),'memory.events.local':('max','oom','oom_kill'),'pids.events':('max',)}
COMMON_PROFILE='common-visible-cgroup2-v1'
COMMON_SOURCES=SOURCES+('subscription-cgroup-common-view-service.py','subscription-cgroup-common-view.py',
    'subscription-cgroup-common-view-child.py','subscription-cgroup-common-view-preflight.py',
    'subscription-cgroup-target-ancestry.py','subscription-cgroup-evidence-stream.py','subscription-cgroup-evidence-validation.py')
COMMON_DEPS=('subscription-cgroup-evidence-stream.py','subscription-cgroup-common-view-service.py',
    'subscription-cgroup-common-view.py','subscription-cgroup-target-ancestry.py',
    'subscription-candidate-resource-events.py','subscription-cgroup-evidence-validation.py')

def integer(v,lo=0,hi=18446744073709551615):return type(v) is int and lo<=v<=hi
def exact(v,keys):return type(v) is dict and set(v)==set(keys)
def same(a,b):return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)
def require(value):
    if not value:raise ValueError('EVIDENCE_INVALID')
def clock(v):return type(v) in (int,float) and math.isfinite(v) and v>=0
def sha(raw):return hashlib.sha256(raw).hexdigest()
def namespace(v,kind):return type(v) is str and re.fullmatch(kind+r':\[[1-9][0-9]{0,19}\]',v) is not None
def ident(v,kind):
    require(exact(v,('dev','ino','mode')) and integer(v['dev']) and integer(v['ino'],1) and integer(v['mode'],0,65535) and v['mode']&0o170000==kind)
def raw_record(v,limit):
    require(type(v['rawHex']) is str and len(v['rawHex'])<=limit*2)
    raw=bytes.fromhex(v['rawHex'])
    require(raw.hex()==v['rawHex'] and integer(v['bytes'],1,limit) and len(raw)==v['bytes'] and sha(raw)==v['sha256'])
    return raw
def number(raw,newline=False):
    require(re.fullmatch(rb'(0|[1-9][0-9]{0,19})\n' if newline else rb'(0|[1-9][0-9]{0,19})\n?',raw) is not None)
    result=int(raw);require(integer(result));return result
def parse_file(name,raw):
    require(0<len(raw)<=4096)
    if name in LIMITS or name in ('memory.current','pids.current'):return number(raw)
    if name=='cgroup.procs':
        values=[number(x) for x in raw.splitlines()]
        require(1<=len(values)<=64 and len(set(values))==len(values) and all(integer(x,2,2147483647) for x in values));return values
    values={}
    for line in raw.splitlines():
        pair=line.split(b' ');require(len(pair)==2 and re.fullmatch(rb'[a-z_]{1,32}',pair[0]) is not None)
        key=pair[0].decode('ascii');require(key not in values and len(values)<16);values[key]=number(pair[1])
    require(set(COUNTERS.get(name,('populated','frozen')))<=set(values))
    if name=='cgroup.events':require(values=={'populated':1,'frozen':0})
    return values

def sample(v,unit,leaf,driver,previous):
    require(exact(v,('version','unit','leaf','directory','observerCgroup','sequence','monotonic','values','files','unitCleanupAttestedHere','exhaustionValidatedHere','sealedMonotonic')))
    require(type(v['version']) is int and v['version']==1 and v['unit']==unit and v['leaf']==leaf and v['observerCgroup']==driver and v['unitCleanupAttestedHere'] is False and v['exhaustionValidatedHere'] is False)
    require(type(driver) is str and driver.startswith('/') and driver!=leaf.removeprefix('/sys/fs/cgroup') and not driver.startswith(leaf.removeprefix('/sys/fs/cgroup')+'/'))
    require(integer(v['sequence'],1,32) and clock(v['monotonic']) and clock(v['sealedMonotonic']) and v['monotonic']<=v['sealedMonotonic'])
    ident(v['directory'],0o40000);require(exact(v['files'],FILES) and exact(v['values'],FILES))
    for name in FILES:
        item=v['files'][name]
        if same(item,{'available':False,'errno':2}):require(name=='memory.events.local' and v['values'][name] is None);continue
        require(exact(item,('available','identity','bytes','sha256','rawHex')) and item['available'] is True)
        ident(item['identity'],0o100000);require(item['identity']['dev']==v['directory']['dev'])
        require(same(parse_file(name,raw_record(item,4096)),v['values'][name]))
    require(all(type(v['values'][k]) is int and v['values'][k]==x for k,x in LIMITS.items()) and v['values']['pids.current']<=64)
    if previous:
        require(v['sequence']>previous['sequence'] and v['monotonic']>=previous['sealedMonotonic'] and same(v['directory'],previous['directory']))
        for name in FILES:
            a,b=v['files'][name],previous['files'][name]
            require(a['available'] is b['available'])
            if a['available']:require(same(a['identity'],b['identity']))
        for name in COUNTERS:
            a,b=v['values'][name],previous['values'][name]
            if a is None:require(b is None)
            else:require(type(b) is dict and set(a)==set(b) and all(a[k]>=b[k] for k in a))
    return v

def capacity_file(record,path):
    require(exact(record,('path','identity','rawHex','sha256','bytes')) and record['path']==path)
    i=record['identity'];require(type(i) is list and len(i)==3 and integer(i[0]) and integer(i[1],1) and type(i[2]) is int and i[2]==0o100000)
    return raw_record(record,65536)
def available(raw):
    lines=[x for x in raw.splitlines() if x.startswith(b'MemAvailable:')];require(len(lines)==1)
    m=re.fullmatch(rb'MemAvailable:\s+([0-9]{1,20}) kB',lines[0]);require(m is not None);return int(m[1])*1024
def capacity(e,uid,old_view=None):
    require(exact(e,('view','capacity')) and exact(e['view'],('pid','cgroup')) and all(namespace(e['view'][k],k) for k in ('pid','cgroup')))
    if old_view is not None:require(same(e['view'],old_view))
    return capacity_payload(e['capacity'],uid)

def capacity_payload(c,uid):
    require(exact(c,('version','admitted','memoryReserveBytes','taskReserve','hostBefore','hostAfter','availableBeforeBytes','availableAfterBytes','ancestors','reservationMade','resourceEnforcementValidated','cgroupWrites','metadataReads','sealedMonotonic')))
    require(type(c['version']) is int and c['version']==1 and c['admitted'] is True and c['reservationMade'] is False and c['resourceEnforcementValidated'] is False and type(c['cgroupWrites']) is int and c['cgroupWrites']==0 and type(c['metadataReads']) is int and c['metadataReads']==18 and clock(c['sealedMonotonic']))
    require(type(c['memoryReserveBytes']) is int and c['memoryReserveBytes']==4294967296 and type(c['taskReserve']) is int and c['taskReserve']==128)
    for name,key in (('hostBefore','availableBeforeBytes'),('hostAfter','availableAfterBytes')):
        value=available(capacity_file(c[name],'/proc/meminfo'));require(type(c[key]) is int and c[key]==value and value>=4294967296)
    require(same(c['hostBefore']['identity'],c['hostAfter']['identity']))
    roots=['/sys/fs/cgroup/user.slice','/sys/fs/cgroup/user.slice/user-'+str(uid)+'.slice']
    roots+=[roots[-1]+'/user@'+str(uid)+'.service'];roots+=[roots[-1]+'/app.slice']
    require(type(c['ancestors']) is list and len(c['ancestors'])==4)
    for ancestor,path in zip(c['ancestors'],roots):
        require(exact(ancestor,('path','files','memoryHeadroom','taskHeadroom')) and ancestor['path']==path and exact(ancestor['files'],('memory.max','memory.current','pids.max','pids.current')))
        parsed={}
        for name,record in ancestor['files'].items():
            raw=capacity_file(record,path+'/'+name);parsed[name]=None if name.endswith('.max') and raw==b'max\n' else number(raw,True)
        for prefix,key,reserve in (('memory','memoryHeadroom',4294967296),('pids','taskHeadroom',128)):
            maximum=parsed[prefix+'.max'];value=None if maximum is None else maximum-parsed[prefix+'.current']
            require(same(value,ancestor[key]) and (value is None or value>=reserve))
    return c['sealedMonotonic']

def worker_identity(value):
    require(exact(value,('pid','startTicks','pidNamespace','nspid')) and integer(value['pid'],1,2147483647) and type(value['startTicks']) is str and re.fullmatch('[1-9][0-9]{0,19}',value['startTicks']) is not None and namespace(value['pidNamespace'],'pid'))
    n=value['nspid'];require(type(n) is list and 1<=len(n)<=8 and all(integer(x,1,2147483647) for x in n) and n[-1]==value['pid'])

def validate_observations(phase,frames,child_report,expected_source_hashes):
    """Caller separately source-binds child replay and capsule/systemd cleanup."""
    return _validate_observations(phase,frames,child_report,expected_source_hashes,None)

def _validate_observations(phase,frames,child_report,expected_source_hashes,common):
    try:
        require(phase in ('tasks','memory') and type(frames) is list and len(frames)<=4096)
        require(exact(expected_source_hashes,SOURCES if common is None else COMMON_SOURCES) and all(type(x) is str and re.fullmatch('[a-f0-9]{64}',x) for x in expected_source_hashes.values()))
        ready=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='ready'];terminal=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='terminal']
        require(len(ready)==len(terminal)==1 and ready[0][0]<terminal[0][0]);boundary=ready[0][1]['systemdFixtureBoundary'];unit=boundary['unit'];uid=boundary['uid'];control=boundary['control']
        require(type(unit) is str and re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',unit) and integer(uid,1,4294967294))
        leaf='/sys/fs/cgroup/user.slice/user-'+str(uid)+'.slice/user@'+str(uid)+'.service/app.slice/'+unit
        require(boundary['leaf']==leaf)
        observer=terminal[0][1]['candidateStressObserver'];require(exact(observer,('sourceSha256','observationSha256','localHandlesClosed','exhaustionValidated')+(() if common is None else ('namespaceEvidenceProfile','documents'))) and same(observer['sourceSha256'],expected_source_hashes) and observer['localHandlesClosed'] is True and observer['exhaustionValidated'] is False)
        entries=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='candidate_stress_observation']
        require(5<=len(entries)<=40 and type(observer['observationSha256']) is list and len(observer['observationSha256'])==len(entries))
        require([f['stage'] for i,f in entries[:4]]==['before-unit-capacity','baseline','before-work-capacity','workers-held'] and all(f['stage']=='release-observation' for i,f in entries[4:]))
        require(entries[0][0]<ready[0][0]<entries[1][0] and entries[-1][0]<terminal[0][0])
        for (i,f),digest in zip(entries,observer['observationSha256']):
            require(exact(f,('version','type','phase','unit','stage','evidence','exhaustionValidated')) and type(f['version']) is int and f['version']==1 and f['phase']==phase and f['unit']==unit and f['exhaustionValidated'] is False)
            raw=json.dumps(f,separators=(',',':'),allow_nan=False).encode();require(len(raw)<=45000 and sha(raw)==digest)
        cap0=entries[0][1]['evidence'];t=capacity(cap0,uid) if common is None else common_capacity(cap0,uid,common,'open')
        baseline=entries[1][1]['evidence'];require(exact(baseline,('unit','control','baseline','sourceSha256','releaseAdmitted','sealedMonotonic')) and baseline['unit']==unit and same(baseline['control'],control) and baseline['releaseAdmitted'] is False and same(baseline['sourceSha256'],{n:expected_source_hashes[n] for n in SOURCES[1:4]}))
        previous=sample(baseline['baseline'],unit,leaf,control['driverCgroup'],None)
        require(previous['monotonic']>=t and clock(baseline['sealedMonotonic']) and baseline['sealedMonotonic']>=previous['sealedMonotonic'])
        cap1=entries[2][1]['evidence'];require((capacity(cap1,uid,cap0['view']) if common is None else common_capacity(cap1,uid,common,'work'))>=baseline['sealedMonotonic'])
        if common is not None: bind_common_baseline(common,baseline,entries,ready,terminal,control)
        records=child_report['protocol']['records'];require(child_report['phase']==phase and child_report['success'] is True and child_report['protocol']['complete'] is True and len(records)==(2 if phase=='tasks' else 3))
        held,workload=records[0],records[-1];require(held['type']=='held' and held['phase']==phase and workload['phase']==phase and workload['normalRelease'] is True and workload['expectedWorkloadOutcome'] is True)
        require(type(held['childIdentities']) is list and integer(held['children'],1,64) and len(held['childIdentities'])==held['children'])
        if phase=='memory':require(held['children']==2 and type(held['bytesPerAllocator']) is int and held['bytesPerAllocator']==805306368)
        w=held['workerIdentity'];require(w['pidNamespace']==w['procInitPidNamespace'] and w['pidNamespace']!=(cap0['view']['pid'] if common is None else common['bodies']['service']['observerAfter']['selfIdentity']['pidNamespace']))
        identities=[{'pid':w['pid'],'startTicks':w['startTicks'],'pidNamespace':w['pidNamespace'],'nspid':[w['pid']]}]+[{'pid':c['pid'],'startTicks':c['startTicks'],'pidNamespace':w['pidNamespace'],'nspid':[c['pid']]} for c in held['childIdentities']]
        require(len({x['pid'] for x in identities})==len(identities))
        for item in identities:worker_identity(item)
        admission=entries[3][1]['evidence'];require(exact(admission,('unit','phase','workers','sample','releaseAdmitted','releaseWritten','exhaustionValidated','sealedMonotonic')) and admission['unit']==unit and admission['phase']==phase and admission['releaseAdmitted'] is True and admission['releaseWritten'] is False and admission['exhaustionValidated'] is False)
        previous=sample(admission['sample'],unit,leaf,control['driverCgroup'],previous);require(previous['monotonic']>=cap1['capacity']['sealedMonotonic'] and clock(admission['sealedMonotonic']) and admission['sealedMonotonic']>=previous['sealedMonotonic'])
        workers=admission['workers'];require(type(workers) is dict and set(workers)=={str(x['pid']) for x in identities})
        hosts=set()
        for item in identities:
            observed=workers[str(item['pid'])];require(exact(observed,('hostPid','identity','reportedIdentity')) and same(observed['reportedIdentity'],item));worker_identity(observed['identity'])
            actual=observed['identity'];require(integer(observed['hostPid'],2,2147483647) and actual['nspid'][0]==observed['hostPid'] and observed['hostPid'] in previous['values']['cgroup.procs'] and actual['pid']==item['pid'] and actual['startTicks']==item['startTicks'] and actual['pidNamespace']==item['pidNamespace']);hosts.add(observed['hostPid'])
        require(len(hosts)==len(identities))
        basevalues=baseline['baseline']['values'];last_dead=set();last_release=None;last_end=admission['sealedMonotonic']
        for i,f in entries[4:]:
            e=f['evidence'];require(exact(e,('sample','outcomes','releaseAdmitted')) and type(e['releaseAdmitted']) is bool)
            previous=sample(e['sample'],unit,leaf,control['driverCgroup'],previous);require(previous['monotonic']>=last_end);out=e['outcomes']
            require(exact(out,('unit','outcomes','exhaustionValidated','unitCleanupAttested','sealedMonotonic')) and out['unit']==unit and out['exhaustionValidated'] is False and out['unitCleanupAttested'] is False and clock(out['sealedMonotonic']) and out['sealedMonotonic']>=previous['sealedMonotonic'])
            require(type(out['outcomes']) is list and len(out['outcomes'])==len(workers));seen=set();dead=set()
            last_end=out['sealedMonotonic']
            for result in out['outcomes']:
                require(exact(result,('hostPid','identity','pidfdExitObserved','returnCode','reapedByObserver')) and result['returnCode'] is None and result['reapedByObserver'] is False and type(result['pidfdExitObserved']) is bool)
                pid=result['identity']['pid'];require(str(pid) in workers and pid not in seen);seen.add(pid)
                require(same(result['identity'],workers[str(pid)]['identity']) and result['hostPid']==workers[str(pid)]['hostPid'])
                if result['pidfdExitObserved']:dead.add(pid)
            require(w['pid'] not in dead and last_dead<=dead);last_dead=dead
            expected=previous['values']['pids.current']==64 and previous['values']['pids.events']['max']>basevalues['pids.events']['max'] if phase=='tasks' else previous['values']['memory.events']['oom_kill']>basevalues['memory.events']['oom_kill'] and bool(dead)
            require(e['releaseAdmitted'] is bool(expected));last_release=e
        require(last_release['releaseAdmitted'] is True)
        terminal_children=workload['children'];require(type(terminal_children) is list and len(terminal_children)==len(held['childIdentities']))
        actual_by_pid={c['pid']:c for c in terminal_children};require(set(actual_by_pid)=={c['pid'] for c in held['childIdentities']})
        for c in held['childIdentities']:
            actual=actual_by_pid[c['pid']];require(same(actual['identity'],c) and type(actual['returncode']) is int and actual['pinAcquired'] is True and actual['errors']==[] and all(actual[k] is True for k in ('commandClosed','reportClosed','pidfdClosed')))
            if actual['returncode']==0:require(c['pid'] not in last_dead and actual['released'] is True and actual['events']==([] if phase=='tasks' else ['H','F']))
            else:require(phase=='memory' and actual['returncode']==-9 and c['pid'] in last_dead and actual['events'] in (['H'],['H','F']))
        if phase=='tasks':require(type(held['forkErrno']) is int and held['forkErrno']==11 and type(workload['forkErrno']) is int and workload['forkErrno']==11 and admission['sample']['values']['pids.current']==64 and not last_dead and all(c['returncode']==0 for c in terminal_children))
        else:
            require(len(terminal_children)==2 and same(records[1],{'type':'ramp-complete','phase':'memory','allocationCapPerChild':1207959552}) and any(c['returncode']==-9 for c in terminal_children))
            for name in ('memory.events','memory.events.local'):
                if basevalues[name] is not None:require(all(previous['values'][name][k]>basevalues[name][k] for k in ('max','oom','oom_kill')))
        return True
    except (ValueError,TypeError,KeyError,IndexError,AttributeError,OverflowError,RecursionError):return False


def common_capacity(value,uid,common,stage):
    require(exact(value,('namespaceEvidenceProfile','view','capacity')) and value['namespaceEvidenceProfile']==COMMON_PROFILE)
    before_label='capacity-before-'+stage;after_label='capacity-after-'+stage
    require(same(value['view'],{'beforeDocument':before_label,'afterDocument':after_label}))
    before=common['bodies'][before_label];after=common['bodies'][after_label]
    sealed=capacity_payload(value['capacity'],uid)
    require(before['sealedMonotonic']<=sealed<=after['startedMonotonic'])
    # Capacity files belong to the same visible cgroup filesystem as the
    # directory anchors. File contents still receive the original raw checks.
    for ancestor in value['capacity']['ancestors']:
        device=before['directories'][ancestor['path']]['identity']['dev']
        require(all(record['identity'][0]==device for record in ancestor['files'].values()))
    return sealed


def bind_common_baseline(common,baseline,entries,ready,terminal,control):
    bodies=common['bodies'];service=bodies['service'];anchor=service['observerAfter'];target=bodies['target-ancestry']
    for binding in (service['bindingBefore'],service['bindingAfter']):
        for key in ('managerIdentityProfile','managerPid','managerUid','managerStartTimeTicks','managerCgroup','driverPid','driverCgroup'):
            require(same(binding[key],control[key]))
        a,b=binding['managerSocket'],control['managerSocket']
        require(a['path']==b['path'] and len(a['components'])==len(b['components']))
        for left,right in zip(a['components'],b['components']):
            for key in ('dev','ino','mode','uid'):require(same(left[key],right[key]))
            if 'gid' in right:require(same(left['gid'],right['gid']))
        if 'managerGid' in control:require(same(binding['managerGid'],control['managerGid']))
    require(anchor['selfIdentity']['pid']==control['driverPid'] and anchor['membership']==control['driverCgroup'])
    require(baseline['unit']==target['unit'])
    first=baseline['baseline'];last=target['eventAfter']
    require(same(first['directory'],target['eventBefore']['directory']) and first['observerCgroup']==anchor['membership'])
    require(first['sequence']<target['eventBefore']['sequence'] and first['sealedMonotonic']<=target['eventBefore']['monotonic'])
    # Apply the original identity/counter checks across target's intervening
    # reads too, without inserting invented observations into the raw stream.
    previous=sample(target['eventBefore'],target['unit'],target['leaf'],anchor['membership'],first)
    previous=sample(last,target['unit'],target['leaf'],anchor['membership'],previous)
    sample(entries[3][1]['evidence']['sample'],target['unit'],target['leaf'],anchor['membership'],previous)
    positions=common['positions']
    require(positions['capacity-after-open']<entries[0][0]<ready[0][0])
    require(ready[0][0]<positions['target-ancestry']<entries[1][0])
    require(entries[1][0]<positions['capacity-before-work']<positions['capacity-after-work']<entries[2][0])
    require(positions['capacity-after-work']<terminal[0][0])


def validate_common_observations(phase,frames,child_report,expected_source_hashes,deps):
    """Explicit new profile. Driver separately proves original wire canonicality,
    actual control writes, all source bytes, capsule and target cleanup.
    deps=(codec,service,sampler,target,events,linkage), source-bound by caller.
    """
    try:
        require(type(deps) is tuple and len(deps)==6 and exact(expected_source_hashes,COMMON_SOURCES))
        require(all(type(v) is str and re.fullmatch('[a-f0-9]{64}',v) for v in expected_source_hashes.values()))
        for name,module in zip(COMMON_DEPS,deps):require(getattr(module,'__source_sha256__',None)==expected_source_hashes[name])
        codec,service,sampler,target,events,linkage=deps
        require(type(frames) is list and len(frames)<=4096)
        terminals=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='terminal']
        readies=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='ready']
        require(len(terminals)==len(readies)==1)
        unit=readies[0][1]['systemdFixtureBoundary']['unit'];decoder=codec.Decoder(unit)
        documents={};positions={};service_frames=[]
        for i,value in enumerate(frames):
            if type(value) is not dict or value.get('type')!='cgroup_evidence':continue
            require(i<terminals[0][0])
            wire=codec.canonical(value)
            result=decoder.feed(wire)
            if value['label']=='service':service_frames.append(wire)
            if result is not None:documents[result['label']]=result['raw'];positions[result['label']]=i
        summaries=decoder.finish()
        observer=terminals[0][1]['candidateStressObserver']
        require(observer['namespaceEvidenceProfile']==COMMON_PROFILE and same(observer['documents'],summaries))
        expected_link={name:expected_source_hashes[name] for name in set(service.FILES)|set(target.FILES)}
        require(linkage.validate_documents(documents,unit,expected_link,(service,sampler,target,events)) is True)
        bodies={label:linkage.strict(raw) for label,raw in documents.items()}
        receipts=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='common_view_preflight']
        admissions=[(i,f) for i,f in enumerate(frames) if type(f) is dict and f.get('type')=='common_view_ready']
        require(len(receipts)==len(admissions)==1)
        ri,receipt=receipts[0];ai,admission=admissions[0]
        require(positions['service']<ri<ai<positions['capacity-before-open']<readies[0][0])
        expected_receipt={'version':1,'type':'common_view_preflight','targetUnit':unit,
            'sourceSha256':{name:expected_source_hashes[name] for name in service.FILES},
            'dependencySha256':{name:expected_source_hashes[name] for name in (
                'subscription-cgroup-common-view-service.py','subscription-cgroup-common-view.py',
                'subscription-cgroup-evidence-stream.py','subscription-candidate-resource-events.py')},
            'documentSha256':sha(documents['service']),'documentBytes':len(documents['service']),
            'framesEnqueued':len(service_frames),'framesPolled':len(service_frames),
            'wireBytesPolled':sum(map(len,service_frames)),'maxQueueBytes':receipt['maxQueueBytes'],
            'workerFinished':True,'queueDocumentDrained':True,'localHandlesKnown':True,'closeKnown':True,
            'cancelled':False,'error':None,'releaseAdmitted':False,'productionReady':False}
        require(same(receipt,expected_receipt) and integer(receipt['maxQueueBytes'],max(map(len,service_frames)),262144))
        require(same(admission,{'version':1,'type':'common_view_ready','unit':unit,
            'sha256':sha(documents['service']),'bytes':len(documents['service'])}))
        common={'bodies':bodies,'positions':positions}
        return _validate_observations(phase,frames,child_report,expected_source_hashes,common)
    except (ValueError,TypeError,KeyError,IndexError,AttributeError,OverflowError,RecursionError):return False
