"""Pure authored evidence, without OS calls or resource allocations."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import pytest

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=load('subscription-candidate-resource-stress-evidence')
child=load('subscription-candidate-resource-stress-child.test')

def hashes():return {n:'a'*64 for n in m.SOURCES}
def blob(raw):return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'rawHex':raw.hex()}
def capacity_file(path,raw,i):return {'path':path,'identity':[1,i,0o100000],**blob(raw)}
def capacity(uid,t):
    roots=['/sys/fs/cgroup/user.slice','/sys/fs/cgroup/user.slice/user-'+str(uid)+'.slice']
    roots+=[roots[-1]+'/user@'+str(uid)+'.service'];roots+=[roots[-1]+'/app.slice']
    host=capacity_file('/proc/meminfo',b'MemAvailable: 8388608 kB\n',1)
    ancestors=[]
    for j,path in enumerate(roots):
        ancestors.append({'path':path,'files':{n:capacity_file(path+'/'+n,b'max\n' if n.endswith('.max') else b'1\n',10+j*4+i) for i,n in enumerate(('memory.max','memory.current','pids.max','pids.current'))},'memoryHeadroom':None,'taskHeadroom':None})
    return {'view':{'pid':'pid:[2]','cgroup':'cgroup:[3]'},'capacity':{'version':1,'admitted':True,'memoryReserveBytes':4294967296,'taskReserve':128,
      'hostBefore':host,'hostAfter':copy.deepcopy(host),'availableBeforeBytes':8589934592,'availableAfterBytes':8589934592,'ancestors':ancestors,
      'reservationMade':False,'resourceEnforcementValidated':False,'cgroupWrites':0,'metadataReads':18,'sealedMonotonic':t}}

def sample(boundary,seq,t,phase,events=0,optional=True):
    values={**m.LIMITS,'memory.current':1000000,'pids.current':64 if phase=='tasks' and seq>1 else 8,
      'memory.events':{'max':events,'oom':events,'oom_kill':events},'memory.events.local':{'max':events,'oom':events,'oom_kill':events} if optional else None,
      'pids.events':{'max':events},'cgroup.events':{'populated':1,'frozen':0},'cgroup.procs':[110,111,112]}
    files={}
    for i,n in enumerate(m.FILES):
        value=values[n]
        if value is None:files[n]={'available':False,'errno':2};continue
        raw=(''.join(str(x)+'\n' for x in value) if type(value) is list else ''.join(k+' '+str(v)+'\n' for k,v in value.items()) if type(value) is dict else str(value)+'\n').encode()
        files[n]={'available':True,'identity':{'dev':2,'ino':i+20,'mode':0o100644},**blob(raw)}
    return {'version':1,'unit':boundary['unit'],'leaf':boundary['leaf'],'directory':{'dev':2,'ino':9,'mode':0o40755},'observerCgroup':boundary['control']['driverCgroup'],
      'sequence':seq,'monotonic':t,'values':values,'files':files,'unitCleanupAttestedHere':False,'exhaustionValidatedHere':False,'sealedMonotonic':t+.1}

def rehash(frames):
    terminal=next(x for x in frames if x.get('type')=='terminal')
    terminal['candidateStressObserver']['observationSha256']=[m.sha(json.dumps(x,separators=(',',':'),allow_nan=False).encode()) for x in frames if x.get('type')=='candidate_stress_observation']

def complete_observations(phase='tasks',expected_source_hashes=None,boundary=None,optional=True):
    """Reusable authored fixture: caller may supply its full resource boundary."""
    expected_source_hashes=expected_source_hashes or hashes()
    if boundary is None:
        unit='codex-cli-resource-'+'1'*32+'.service'
        boundary={'unit':unit,'uid':1000,'leaf':'/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/'+unit,'control':{'driverCgroup':'/user.slice/observer'}}
    boundary=copy.deepcopy(boundary);unit=boundary['unit'];uid=boundary['uid'];report=child.complete_report(phase)
    held=report['protocol']['records'][0];w=held['workerIdentity']
    def observation(stage,evidence):return {'version':1,'type':'candidate_stress_observation','phase':phase,'unit':unit,'stage':stage,'evidence':evidence,'exhaustionValidated':False}
    before=sample(boundary,1,2,phase,optional=optional)
    baseline={'unit':unit,'control':copy.deepcopy(boundary['control']),'baseline':before,'sourceSha256':{n:expected_source_hashes[n] for n in m.SOURCES[1:4]},'releaseAdmitted':False,'sealedMonotonic':2.2}
    workers={}
    for v in [{'pid':w['pid'],'startTicks':w['startTicks']}]+held['childIdentities']:
        original={**v,'pidNamespace':w['pidNamespace'],'nspid':[v['pid']]}
        workers[str(v['pid'])]={'hostPid':v['pid']+100,'identity':{**original,'nspid':[v['pid']+100,v['pid']]},'reportedIdentity':original}
    admission={'unit':unit,'phase':phase,'workers':workers,'sample':sample(boundary,3,4,phase,optional=optional),'releaseAdmitted':True,'releaseWritten':False,'exhaustionValidated':False,'sealedMonotonic':4.2}
    outcomes={'unit':unit,'outcomes':[{'hostPid':v['hostPid'],'identity':copy.deepcopy(v['identity']),'pidfdExitObserved':phase=='memory' and k=='11','returnCode':None,'reapedByObserver':False} for k,v in workers.items()],
       'exhaustionValidated':False,'unitCleanupAttested':False,'sealedMonotonic':5.2}
    release={'sample':sample(boundary,4,5,phase,1,optional),'outcomes':outcomes,'releaseAdmitted':True}
    frames=[observation('before-unit-capacity',capacity(uid,1)),{'version':1,'type':'ready','systemdFixtureBoundary':boundary},observation('baseline',baseline),
      observation('before-work-capacity',capacity(uid,3)),observation('workers-held',admission),observation('release-observation',release),
      {'version':1,'type':'terminal','candidateStressObserver':{'sourceSha256':dict(expected_source_hashes),'observationSha256':[],'localHandlesClosed':True,'exhaustionValidated':False}}]
    rehash(frames);return frames,report

@pytest.mark.parametrize('phase',['tasks','memory'])
@pytest.mark.parametrize('optional',[False,True])
def test_complete_replay_both_phases_and_optional_local_events(phase,optional):
    frames,report=complete_observations(phase,optional=optional)
    assert m.validate_observations(phase,frames,report,hashes())

@pytest.mark.parametrize('case',['digest','source','close','raw','raw-type','inode-drift','counter-reset','sample-order','capacity','capacity-view','inside-leaf','reported-ticks','host-pid','worker-exit','false-reap','no-kill','victim-mismatch','survivor-no-F','missing-local-delta','claimed-only','unknown-field','version-bool'])
def test_negative_cross_bindings_not_just_boolean_claims(case):
    f,r=complete_observations('memory');ad=f[4]['evidence'];release=f[5]['evidence'];last=release['sample'];base=f[2]['evidence']['baseline']
    if case=='digest':f[-1]['candidateStressObserver']['observationSha256'][0]='b'*64
    if case=='source':f[-1]['candidateStressObserver']['sourceSha256'][m.SOURCES[0]]='b'*64
    if case=='close':f[-1]['candidateStressObserver']['localHandlesClosed']=False
    if case=='raw':last['files']['memory.events']['rawHex']='30300a'
    if case=='raw-type':last['files']['memory.events']['identity']['mode']=0o40755
    if case=='inode-drift':last['files']['memory.events']['identity']['ino']+=1
    if case=='counter-reset':base['values']['memory.events']['max']=2;base['files']['memory.events'].update(blob(b'max 2\noom 0\noom_kill 0\n'))
    if case=='sample-order':last['sequence']=2
    if case=='capacity':f[3]['evidence']['capacity']['hostAfter'].update(blob(b'MemAvailable: 1 kB\n'));f[3]['evidence']['capacity']['availableAfterBytes']=1024
    if case=='capacity-view':f[3]['evidence']['view']['pid']='pid:[999]'
    if case=='inside-leaf':last['observerCgroup']=last['leaf'].removeprefix('/sys/fs/cgroup')
    if case=='reported-ticks':ad['workers']['11']['reportedIdentity']['startTicks']='999'
    if case=='host-pid':ad['workers']['11']['hostPid']=999
    if case=='worker-exit':release['outcomes']['outcomes'][0]['pidfdExitObserved']=True
    if case=='false-reap':release['outcomes']['outcomes'][1]['reapedByObserver']=True
    if case=='no-kill':release['outcomes']['outcomes'][1]['pidfdExitObserved']=False
    if case=='victim-mismatch':r['protocol']['records'][-1]['children'][0]['identity']['startTicks']='999'
    if case=='survivor-no-F':r['protocol']['records'][-1]['children'][1]['events']=['H']
    if case=='missing-local-delta':last['values']['memory.events.local']={'max':0,'oom':0,'oom_kill':0};last['files']['memory.events.local'].update(blob(b'max 0\noom 0\noom_kill 0\n'))
    if case=='claimed-only':last['values']['memory.events']['max']=0;last['files']['memory.events'].update(blob(b'max 0\noom 1\noom_kill 1\n'))
    if case=='unknown-field':ad['unexpected']=True
    if case=='version-bool':last['version']=True
    if case!='digest':rehash(f)
    assert not m.validate_observations('memory',f,r,hashes())

@pytest.mark.parametrize('case',['fork-errno','held-current','release-current','no-max-delta','child-exit'])
def test_tasks_need_actual_eagain_and_64_and_event_delta(case):
    f,r=complete_observations('tasks')
    if case=='fork-errno':r['protocol']['records'][0]['forkErrno']=None
    if case in ('held-current','release-current'):
        s=f[4 if case=='held-current' else 5]['evidence']['sample'];s['values']['pids.current']=63;s['files']['pids.current'].update(blob(b'63\n'))
    if case=='no-max-delta':s=f[5]['evidence']['sample'];s['values']['pids.events']={'max':0};s['files']['pids.events'].update(blob(b'max 0\n'))
    if case=='child-exit':f[5]['evidence']['outcomes']['outcomes'][1]['pidfdExitObserved']=True
    rehash(f);assert not m.validate_observations('tasks',f,r,hashes())


def complete_common_observations(phase='tasks',expected12=None,boundary=None):
    """Full authored composition using real service/target/linkage validators."""
    fixtures=load('subscription-cgroup-evidence-validation.test')
    docs,unit,_,linked=fixtures.complete_documents()
    service,sampler,target,events=linked
    codec=load('subscription-cgroup-evidence-stream');linkage=fixtures.m
    deps=(codec,service,sampler,target,events,linkage)
    expected=expected12 or {name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in m.COMMON_SOURCES}
    for name,module in zip(m.COMMON_DEPS,deps):module.__source_sha256__=expected[name]
    bodies={label:json.loads(raw) for label,raw in docs.items()}
    svc=bodies['service'];ancestry=bodies['target-ancestry']
    control=copy.deepcopy(svc['bindingBefore'])
    control['unitMainCgroup']='/user.slice/user-1000.slice/user@1000.service/app.slice/'+unit
    if boundary is None:
        boundary={'unit':unit,'uid':1000,'leaf':'/sys/fs/cgroup'+control['unitMainCgroup'],'control':control}
    else:
        # Additional actual resource fields are welcome; fixture identity cannot
        # be rewritten independently from its real sampler/service documents.
        assert boundary['unit']==unit and boundary['uid']==1000
        for key in ('managerIdentityProfile','managerPid','managerUid','managerStartTimeTicks','managerCgroup','driverPid','driverCgroup'):
            assert m.same(boundary['control'][key],control[key])
    old,report=complete_observations(phase,expected,boundary)
    baseline=old[2]['evidence'];baseline['baseline']=copy.deepcopy(ancestry['eventBefore'])
    baseline['baseline'].update(sequence=1,monotonic=5.8,sealedMonotonic=5.8)
    baseline['sealedMonotonic']=5.9
    for index,seq,t in ((4,4,9),(5,5,10)):
        sample_value=old[index]['evidence']['sample']
        sample_value.update(sequence=seq,monotonic=t,sealedMonotonic=t+.1,
            directory=copy.deepcopy(ancestry['eventBefore']['directory']))
        for name in m.FILES:
            sample_value['files'][name]['identity']=copy.deepcopy(ancestry['eventBefore']['files'][name]['identity'])
        for name in ('memory.events','memory.events.local'):
            sample_value['values'][name]={'low':0,'high':0,**sample_value['values'][name]}
            raw=''.join(k+' '+str(v)+'\n' for k,v in sample_value['values'][name].items()).encode()
            sample_value['files'][name].update(blob(raw))
    old[4]['evidence']['sealedMonotonic']=9.2
    old[5]['evidence']['outcomes']['sealedMonotonic']=10.2
    for index,stage,t in ((0,'open',5),(3,'work',7.5)):
        cap=old[index]['evidence']['capacity'];cap['sealedMonotonic']=t
        for ancestor in cap['ancestors']:
            for record in ancestor['files'].values():record['identity'][0]=51
        old[index]['evidence']={'namespaceEvidenceProfile':m.COMMON_PROFILE,
            'view':{'beforeDocument':'capacity-before-'+stage,'afterDocument':'capacity-after-'+stage},'capacity':cap}
    def encoded(label):return [json.loads(wire) for wire in codec.encode_document(unit,label,docs[label])]
    service_frames=encoded('service');rawframes=[codec.canonical(f) for f in service_frames]
    receipt={'version':1,'type':'common_view_preflight','targetUnit':unit,
        'sourceSha256':{n:expected[n] for n in service.FILES},
        'dependencySha256':{n:expected[n] for n in (m.COMMON_DEPS[1],m.COMMON_DEPS[2],m.COMMON_DEPS[0],m.COMMON_DEPS[4])},
        'documentSha256':m.sha(docs['service']),'documentBytes':len(docs['service']),
        'framesEnqueued':len(rawframes),'framesPolled':len(rawframes),'wireBytesPolled':sum(map(len,rawframes)),
        'maxQueueBytes':max(map(len,rawframes)),'workerFinished':True,'queueDocumentDrained':True,
        'localHandlesKnown':True,'closeKnown':True,'cancelled':False,'error':None,'releaseAdmitted':False,'productionReady':False}
    admission={'version':1,'type':'common_view_ready','unit':unit,'sha256':m.sha(docs['service']),'bytes':len(docs['service'])}
    frames=service_frames+[receipt,admission]+encoded('capacity-before-open')+encoded('capacity-after-open')+old[:2]+encoded('target-ancestry')+[old[2]]+encoded('capacity-before-work')+encoded('capacity-after-work')+old[3:]
    terminal=frames[-1]['candidateStressObserver']
    terminal.update(namespaceEvidenceProfile=m.COMMON_PROFILE,documents={label:{'label':label,'sha256':m.sha(raw),'bytes':len(raw)} for label,raw in docs.items()})
    rehash(frames)
    return frames,report,expected,deps



@pytest.mark.parametrize('phase',['tasks','memory'])
def test_common_full_real_validation_and_no_input_rewrite(phase):
    frames,report,expected,deps=complete_common_observations(phase)
    original=copy.deepcopy(frames)
    assert m.validate_common_observations(phase,frames,report,expected,deps)
    assert frames==original
    assert not m.validate_observations(phase,frames,report,expected)


@pytest.mark.parametrize('case',['source','annotation','missing-doc','duplicate','terminal-digest','profile',
    'receipt-close','receipt-count','receipt-source','receipt-order','ready-digest','capacity-time','capacity-ref',
    'capacity-device','target-directory','manager-generation','manager-peer','driver-identity','held-counter','victim'])
def test_common_negative_bindings(case):
    f,r,h,d=complete_common_observations('memory')
    terminal=f[-1]['candidateStressObserver'];receipt=next(x for x in f if x['type']=='common_view_preflight')
    ready=next(x for x in f if x['type']=='ready')
    obs=[x for x in f if x['type']=='candidate_stress_observation']
    if case=='source':h[m.COMMON_SOURCES[-1]]='0'*64
    elif case=='annotation':d[4].__source_sha256__='0'*64
    elif case=='missing-doc':f[:]=[x for x in f if x.get('label')!='target-ancestry']
    elif case=='duplicate':f.insert(1,copy.deepcopy(f[0]))
    elif case=='terminal-digest':terminal['documents']['service']['sha256']='0'*64
    elif case=='profile':terminal['namespaceEvidenceProfile']='legacy'
    elif case=='receipt-close':receipt['closeKnown']=False
    elif case=='receipt-count':receipt['framesPolled']+=1
    elif case=='receipt-source':receipt['dependencySha256'][m.COMMON_DEPS[4]]='0'*64
    elif case=='receipt-order':f.remove(receipt);f.insert(0,receipt)
    elif case=='ready-digest':next(x for x in f if x['type']=='common_view_ready')['sha256']='0'*64
    elif case=='capacity-time':obs[2]['evidence']['capacity']['sealedMonotonic']=9
    elif case=='capacity-ref':obs[0]['evidence']['view']['afterDocument']='capacity-after-work'
    elif case=='capacity-device':obs[0]['evidence']['capacity']['ancestors'][0]['files']['memory.max']['identity'][0]=99
    elif case=='target-directory':obs[1]['evidence']['baseline']['directory']['ino']+=1
    elif case in ('manager-generation','manager-peer','driver-identity'):
        key={'manager-generation':'managerStartTimeTicks','manager-peer':'managerPid','driver-identity':'driverPid'}[case]
        for control in (ready['systemdFixtureBoundary']['control'],obs[1]['evidence']['control']):control[key]='999' if key=='managerStartTimeTicks' else 999
    elif case=='held-counter':obs[3]['evidence']['sample']['sequence']=3
    elif case=='victim':r['protocol']['records'][-1]['children'][0]['returncode']=0
    rehash(f)
    assert not m.validate_common_observations('memory',f,r,h,d)


def test_legacy_rejects_common_source_projection_and_common_rejects_legacy():
    f,r=complete_observations()
    _,_,h,d=complete_common_observations()
    assert not m.validate_common_observations('tasks',f,r,h,d)
    f,r,h,d=complete_common_observations()
    assert not m.validate_observations('tasks',f,r,{n:h[n] for n in m.SOURCES})


@pytest.mark.parametrize('case',['service-cleanup','target-raw','snapshot-generation','snapshot-reuse','snapshot-time'])
def test_real_document_validators_reject_even_with_correct_new_transport_hashes(case):
    f,r,h,d=complete_common_observations();codec=d[0]
    unit=next(x for x in f if x['type']=='ready')['systemdFixtureBoundary']['unit']
    decoder=codec.Decoder(unit);docs={}
    for value in f:
        if value['type']=='cgroup_evidence':
            done=decoder.feed(codec.canonical(value))
            if done:docs[done['label']]=done['raw']
    label={'service-cleanup':'service','target-raw':'target-ancestry','snapshot-generation':'capacity-before-work',
           'snapshot-reuse':'capacity-after-open','snapshot-time':'capacity-before-open'}[case]
    body=json.loads(docs[label])
    if case=='service-cleanup':body['cleanup']['unitAbsent']=False
    elif case=='target-raw':body['eventAfter']['files']['memory.max']['rawHex']='300a'
    elif case=='snapshot-generation':body['selfIdentity']['startTicks']='999'
    elif case=='snapshot-reuse':body['sequence']+=1
    else:body['startedMonotonic']=body['sealedMonotonic']=100
    raw=json.dumps(body,separators=(',',':')).encode()
    new=[json.loads(wire) for wire in codec.encode_document(unit,label,raw)]
    pos=next(i for i,x in enumerate(f) if x.get('label')==label)
    f[:]=[x for x in f if x.get('label')!=label];f[pos:pos]=new
    f[-1]['candidateStressObserver']['documents'][label]={'label':label,'sha256':m.sha(raw),'bytes':len(raw)}
    if label=='service':
        receipt=next(x for x in f if x['type']=='common_view_preflight');wire=[codec.canonical(x) for x in new]
        receipt.update(documentSha256=m.sha(raw),documentBytes=len(raw),framesEnqueued=len(wire),framesPolled=len(wire),
            wireBytesPolled=sum(map(len,wire)),maxQueueBytes=max(map(len,wire)))
        next(x for x in f if x['type']=='common_view_ready').update(sha256=m.sha(raw),bytes=len(raw))
    assert not m.validate_common_observations('tasks',f,r,h,d)
