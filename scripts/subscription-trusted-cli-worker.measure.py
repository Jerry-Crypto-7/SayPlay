"""Fixed stock CLI refusal plus isolated worker capsule measurement; no inference."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

SELF='scripts/subscription-trusted-cli-worker.measure.py'
BASE='scripts/subscription-trusted-ingress.measure.py'
DRIVER='scripts/subscription-cli-supervisor.measure.py'
SCENARIO='trusted-cli-worker-boundary'
NEW=('subscription-cli-proxy-refusal.py','subscription-cli-proxy-provenance.py','subscription-trusted-cli-worker-probe.py','subscription-trusted-cli-worker-child.py')
HELPERS=('subscription-exec-server-worker-gate.py','subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py','subscription-trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py','subscription-appserver-noenv.py','subscription-text-model-catalog.json',
    'subscription-trusted-control-boundary-parent.py',*NEW)
_UNKNOWN=False
LOADED_SHA=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
COMMAND=['wsl.exe','-d','Ubuntu-24.04','--','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/timeout','--signal=TERM','--kill-after=5','200',
    '/usr/bin/unshare','--user','--map-current-user','--keep-caps','--mount','--net','--pid','--uts','--fork',
    '/bin/sh','/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh','--trusted-cli-worker-boundary']


def load(path,before=None):
    raw=Path(path).read_bytes();digest=hashlib.sha256(raw).hexdigest()
    if before is not None and before.get(path)!=digest:raise ValueError('TRUSTED_CLI_SOURCE_DRIFT')
    spec=importlib.util.spec_from_file_location('private_refusal_'+Path(path).name,path)
    module=importlib.util.module_from_spec(spec);exec(compile(raw,path,'exec'),module.__dict__)
    module.loadedSha=digest;return module


def start_request(ready,before,scenario=SCENARIO):
    if scenario!=SCENARIO or type(ready) is not dict:raise ValueError('FIXED_TRUSTED_CLI_PROFILE')
    base=load(BASE,before);sandbox=ready.get('sandbox')
    if (ready.get('binarySha256')!=base.CLI_SHA256 or ready.get('bwrapSha256')!=base.BWRAP_SHA256
        or not base.same(ready.get('limits'),base.LIMITS) or type(sandbox) is not dict or set(sandbox)!=set(base.SANDBOX)|{'uid','gid'}
        or not base.integer(sandbox['uid']) or not base.integer(sandbox['gid']) or not base.same({k:sandbox[k] for k in base.SANDBOX},base.SANDBOX)):
        raise ValueError('TRUSTED_CLI_RUNTIME_ADMISSION')
    if 'trustedIngressFd' in ready or 'trustedHttpIngressBoundary' in ready:raise ValueError('TRUSTED_CLI_NO_INGRESS_CAPABILITY')
    helpers=base.expected_hashes(before,HELPERS)
    if not base.same(ready.get('trustedCliWorkerBoundary'),{'helperSha256':helpers}):raise ValueError('TRUSTED_CLI_HELPER_ADMISSION')
    worker=ready.get('workerBoundary')
    if type(worker) is not dict:raise ValueError('TRUSTED_CLI_WORKER_BOUNDARY')
    for key,kind in (('namespace','pid'),('mountNamespace','mnt')):
        if type(worker.get(key)) is not str or re.fullmatch(kind+r':\[[1-9][0-9]*\]',worker[key]) is None:raise ValueError('TRUSTED_CLI_WORKER_NAMESPACE')
    for key in ('control','output'):
        value=worker.get(key)
        if (type(value) is not dict or set(value)!={'dev','ino','type'}
            or any(type(v) is not int or not 0<=v<=9007199254740991 for v in value.values())
            or value['ino']==0 or value['type']!=0o010000):raise ValueError('TRUSTED_CLI_WORKER_PIPE')
    if base.same(worker['control'],worker['output']):raise ValueError('TRUSTED_CLI_WORKER_ALIAS')
    loop=ready.get('trustedHttpLoopback')
    if (type(loop) is not dict or set(loop)!={'interface','namespace','ownerUserNamespace','beforeFlags','afterFlags'} or loop.get('interface')!='lo'
        or type(loop.get('namespace')) is not str or re.fullmatch(r'net:\[[1-9][0-9]*\]',loop['namespace']) is None
        or type(loop.get('ownerUserNamespace')) is not str or re.fullmatch(r'user:\[[1-9][0-9]*\]',loop['ownerUserNamespace']) is None
        or any(type(loop.get(k)) is not int or not 0<=loop[k]<=65535 for k in ('beforeFlags','afterFlags'))
        or loop['beforeFlags']&8!=8 or loop['afterFlags']&9!=9):raise ValueError('TRUSTED_CLI_LOOPBACK_ADMISSION')
    return {'type':'start','mode':SCENARIO,'helperSha256':helpers}


def child_evaluation(report):
    try:
        before=report['sourceSha256Before'];base=load(BASE,before)
        readies=[f for f in report['frames'] if f.get('type')=='ready']
        if len(readies)!=1:return False
        ready=readies[0];helpers=start_request(ready,before)['helperSha256'];raw=bytearray()
        for frame in report['frames']:
            if frame.get('type')!='child_output':continue
            if frame.get('stream')!='stdout' or frame.get('encoding')!='base64':return False
            block=base64.b64decode(frame['data'],validate=True)
            if len(raw)+len(block)>2*1024*1024:return False
            raw.extend(block)
        sources={name:Path('scripts/'+name).read_bytes() for name in HELPERS}
        if any(hashlib.sha256(value).hexdigest()!=helpers[name] for name,value in sources.items()):return False
        child=load('scripts/'+NEW[-1],before)
        policy=load('scripts/subscription-appserver-noenv.py',before)
        body=policy.strict_json(bytes(raw))
        if (not base.same(body.get('helperSha256Before'),helpers) or not base.same(body.get('helperSha256After'),helpers)
            or body['cliIdentity']['networkNamespace']!=ready['trustedHttpLoopback']['namespace']):return False
        return child.validate_report(body,sources,ready['workerBoundary']) is True
    except (ValueError,TypeError,KeyError,AttributeError,OSError,RecursionError):return False


def load_driver(before=None):
    driver=load(DRIVER,before);driver.loadedSourceSha256=driver.loadedSha
    # Exact default copied inventory plus four fixed helpers and two driver sources.
    driver.SOURCES=tuple(dict.fromkeys((*driver.SOURCES,*('scripts/'+n for n in NEW),SELF,BASE)))
    if len(driver.SOURCES)!=27:raise ValueError('TRUSTED_CLI_SOURCE_COUNT')
    driver.SCENARIOS=(*driver.SCENARIOS,SCENARIO);driver.ENVIRONMENT_MODES=(*driver.ENVIRONMENT_MODES,SCENARIO)
    driver.COMMAND=list(COMMAND);driver.environment_evaluation=child_evaluation
    return driver


def evaluate(report):
    try:
        before=report['sourceSha256Before'];base=load(BASE,before);driver=load_driver(before)
        if (before.get(SELF)!=LOADED_SHA or set(before)!=set(driver.SOURCES) or not base.same(before,report['sourceSha256After'])
            or not base.same(report['command'],COMMAND) or report['scenario']!=SCENARIO
            or any(hashlib.sha256(Path(p).read_bytes()).hexdigest()!=h for p,h in before.items())):return False
        frames=report['frames']
        if type(frames) is not list or any(type(f) is not dict for f in frames):return False
        indexes=[]
        for kind in ('ready','started','terminal'):
            found=[i for i,f in enumerate(frames) if f.get('type')==kind]
            if len(found)!=1:return False
            indexes.extend(found)
        if indexes!=sorted(indexes) or indexes[0]!=0 or indexes[-1]!=len(frames)-1:return False
        if any(f.get('type') not in ('ready','started','child_output','terminal') or f.get('type')=='child_output' and not indexes[1]<i<indexes[2] for i,f in enumerate(frames)):return False
        start_request(frames[0],before)
        if not base.same(report['terminal'],frames[-1]):return False
        return driver.evaluate(SCENARIO,report) is True
    except (ValueError,TypeError,KeyError,AttributeError,OSError,RecursionError):return False


def main():
    global _UNKNOWN
    if _UNKNOWN:raise ValueError('TRUSTED_CLI_PRIOR_MEASURE_FAILURE')
    if sys.argv[1:]:raise ValueError('FIXED_TRUSTED_CLI_NO_ARGUMENTS')
    base=load(BASE);base_sha=base.loadedSha
    def bound_driver():
        driver=load_driver();original=driver.source_hashes
        def hashes():
            values=original()
            if values.get(BASE)!=base_sha or values.get(SELF)!=LOADED_SHA:raise ValueError('TRUSTED_CLI_COMPOSED_SOURCE_DRIFT')
            return values
        driver.source_hashes=hashes;return driver
    class Wire(base.ObservedWire):
        def start(self,ready,before,scenario=SCENARIO):
            if self.frames!=[ready]:raise ValueError('TRUSTED_CLI_SINGLE_READY_REQUIRED')
            return start_request(ready,before,scenario)
    base.SCENARIO=SCENARIO;base.COMMAND=list(COMMAND);base.SELF=SELF;base.LOADED_SELF_SHA256=LOADED_SHA
    base.load_driver=bound_driver;base.ObservedWire=Wire;base.evaluate=evaluate
    _UNKNOWN=True
    result=base.main()
    if type(result) is int and result==0:_UNKNOWN=False
    return result


if __name__=='__main__':raise SystemExit(main())
