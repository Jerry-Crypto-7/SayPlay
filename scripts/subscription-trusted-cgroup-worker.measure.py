"""Fixed cgroup write-open diagnostic under the existing trusted capsule."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import sys

SELF='scripts/subscription-trusted-cgroup-worker.measure.py'
BASE='scripts/subscription-trusted-control-boundary.measure.py'
PINS='scripts/subscription-trusted-ingress.measure.py'
SCENARIO='trusted-cgroup-worker-boundary'
NEW=('subscription-trusted-cgroup-worker-probe.py','subscription-trusted-cgroup-worker-child.py')
LOADED_SHA=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load(path,before=None):
    raw=Path(path).read_bytes();digest=hashlib.sha256(raw).hexdigest()
    if before is not None and before.get(path)!=digest:raise ValueError('CGROUP_MEASURE_SOURCE_DRIFT')
    spec=importlib.util.spec_from_file_location('private_cgroup_'+Path(path).name,path)
    module=importlib.util.module_from_spec(spec);exec(compile(raw,path,'exec'),module.__dict__)
    module.loadedSha=digest;return module


def start_request(ready,before,requested=SCENARIO):
    if requested!=SCENARIO:raise ValueError('FIXED_CGROUP_PROFILE')
    base=load(BASE,before);pins=load(PINS,before)
    base.start_request(ready,before)
    sandbox=ready.get('sandbox')
    if (ready.get('binarySha256')!=pins.CLI_SHA256 or ready.get('bwrapSha256')!=pins.BWRAP_SHA256
        or not pins.same(ready.get('limits'),pins.LIMITS) or type(sandbox) is not dict or set(sandbox)!=set(pins.SANDBOX)|{'uid','gid'}
        or not pins.integer(sandbox['uid']) or not pins.integer(sandbox['gid']) or not pins.same({k:sandbox[k] for k in pins.SANDBOX},pins.SANDBOX)):
        raise ValueError('CGROUP_RUNTIME_ADMISSION')
    if 'trustedIngressFd' in ready:raise ValueError('CGROUP_NO_INGRESS_FD')
    helpers=pins.expected_hashes(before,(*base.HELPERS,*NEW))
    if not pins.same(ready.get('trustedCgroupWorkerBoundary'),{'helperSha256':helpers}):raise ValueError('CGROUP_HELPER_ADMISSION')
    return {'type':'start','mode':SCENARIO,'helperSha256':helpers}


def child_evaluation(report):
    try:
        before=report['sourceSha256Before'];base=load(BASE,before);pins=load(PINS,before)
        readies=[f for f in report['frames'] if f.get('type')=='ready']
        if len(readies)!=1:return False
        helpers=start_request(readies[0],before)['helperSha256'];raw=bytearray()
        for frame in report['frames']:
            if frame.get('type')!='child_output':continue
            if frame.get('stream')!='stdout' or frame.get('encoding')!='base64':return False
            block=base64.b64decode(frame['data'],validate=True)
            if len(raw)+len(block)>2*1024*1024:return False
            raw.extend(block)
        names=('subscription-trusted-control-boundary-parent.py','subscription-appserver-noenv.py','subscription-exec-server-worker-gate.py',
            'subscription-trusted-control-boundary-probe.py',*NEW)
        modules={n:load('scripts/'+n,before) for n in names}
        body=modules['subscription-appserver-noenv.py'].strict_json(bytes(raw))
        if not pins.same(body.get('helperSha256Before'),helpers) or not pins.same(body.get('helperSha256After'),helpers):return False
        return modules[NEW[-1]].validate_report(body,tuple(modules[n] for n in names[:-1]),readies[0]['workerBoundary']) is True
    except (ValueError,TypeError,KeyError,AttributeError,OSError,RecursionError):return False


def load_driver(before=None):
    base=load(BASE,before);driver=base.load_driver(before)
    driver.SOURCES=tuple(dict.fromkeys((*driver.SOURCES,PINS,SELF,*('scripts/'+n for n in NEW))))
    if len(driver.SOURCES)!=26:raise ValueError('CGROUP_SOURCE_COUNT')
    driver.SCENARIOS=(*driver.SCENARIOS,SCENARIO);driver.ENVIRONMENT_MODES=(*driver.ENVIRONMENT_MODES,SCENARIO)
    driver.COMMAND=[*driver.COMMAND,'--trusted-cgroup-worker-boundary']
    driver.environment_start=start_request;driver.environment_evaluation=child_evaluation
    return driver


def evaluate(report):
    try:
        before=report['sourceSha256Before'];pins=load(PINS,before);driver=load_driver(before)
        if (before.get(SELF)!=LOADED_SHA or set(before)!=set(driver.SOURCES) or not pins.same(before,report['sourceSha256After'])
            or not pins.same(report['command'],driver.COMMAND) or report['scenario']!=SCENARIO
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
        if not pins.same(report['terminal'],frames[-1]):return False
        return driver.evaluate(SCENARIO,report) is True
    except (ValueError,TypeError,KeyError,AttributeError,OSError,RecursionError):return False


def main():
    if sys.argv[1:]:raise ValueError('FIXED_CGROUP_NO_ARGUMENTS')
    base=load(BASE);base_sha=base.loadedSha
    def bound_driver():
        driver=load_driver();original=driver.source_hashes
        def hashes():
            values=original()
            if values.get(BASE)!=base_sha or values.get(SELF)!=LOADED_SHA:raise ValueError('CGROUP_CAPTURE_SOURCE_DRIFT')
            return values
        driver.source_hashes=hashes;return driver
    base.SCENARIO=SCENARIO;base.load_driver=bound_driver;base.evaluate=evaluate
    return base.main()


if __name__=='__main__':raise SystemExit(main())
