"""Actual stock CLI refusal profile under the fixed private systemd envelope."""
import hashlib
import importlib.util
from pathlib import Path
import sys

SELF='scripts/subscription-cli-proxy-refusal-systemd.measure.py'
BASIC='scripts/subscription-cli-proxy-refusal.measure.py'
RESOURCE='scripts/subscription-exec-environment-systemd.measure.py'
RELAY='scripts/subscription-systemd-fixture-transport.py'
PROBE='scripts/subscription-systemd-cli-probe.py'
SCENARIO='cli-proxy-refusal'
COMMAND=['wsl.exe','-d','Ubuntu-24.04','--','/usr/bin/env','-i','PATH=/usr/bin:/bin',
    '/usr/bin/python3','-I','-S','/mnt/d/claude/Hackaton/scripts/subscription-systemd-fixture-transport.py','--cli-proxy-refusal']
LOADED_SHA=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def load(path,before=None):
    raw=Path(path).read_bytes();digest=hashlib.sha256(raw).hexdigest()
    if before is not None and before.get(path)!=digest:raise ValueError('SYSTEMD_REFUSAL_SOURCE_DRIFT')
    spec=importlib.util.spec_from_file_location('private_systemd_refusal_'+Path(path).name,path)
    module=importlib.util.module_from_spec(spec);exec(compile(raw,path,'exec'),module.__dict__)
    module.loadedSha=digest;return module


def stack(before=None):
    basic=load(BASIC,before);resource=load(RESOURCE,before);driver=basic.load_driver(before)
    driver.SOURCES=tuple(dict.fromkeys((*driver.SOURCES,SELF,RESOURCE,RELAY,PROBE)))
    if len(driver.SOURCES)!=30:raise ValueError('SYSTEMD_REFUSAL_SOURCE_COUNT')
    driver.COMMAND=list(COMMAND);driver.environment_start=basic.start_request
    driver.composedSources={SELF:LOADED_SHA,BASIC:basic.loadedSha,RESOURCE:resource.loadedSha}
    resource.SELF=SELF;resource.load_driver=lambda before=None:driver
    resource.fixed_command=lambda requested:list(COMMAND) if requested==SCENARIO else None
    return basic,resource,driver


def start_request(frames,ready,before,requested=SCENARIO):
    if requested!=SCENARIO or type(frames) is not list or any(type(f) is not dict for f in frames):raise ValueError('SYSTEMD_REFUSAL_PROFILE')
    if len(frames)!=2 or [f.get('type') for f in frames]!=['systemd_ownership','ready']:raise ValueError('SYSTEMD_REFUSAL_PRESTART_ORDER')
    basic,resource,_=stack(before);owner=frames[0]
    if (set(owner)!={'version','type','ownership'} or type(owner['version']) is not int or owner['version']!=1
        or not resource.same(frames[1],ready) or not resource.validate_ready(ready,owner['ownership'],before)):
        raise ValueError('SYSTEMD_REFUSAL_RESOURCE_ADMISSION')
    return basic.start_request(ready,before,requested)


def evaluate(report):
    try:
        before=report['sourceSha256Before'];basic,resource,driver=stack(before)
        if before.get(SELF)!=LOADED_SHA:return False
        frames=report['frames']
        if type(frames) is not list or any(type(f) is not dict for f in frames):return False
        indexes=[]
        for kind in ('systemd_ownership','ready','started','terminal'):
            found=[i for i,f in enumerate(frames) if f.get('type')==kind]
            if len(found)!=1:return False
            indexes.extend(found)
        if indexes!=sorted(indexes) or indexes[:2]!=[0,1] or indexes[-1]!=len(frames)-1:return False
        if any(f.get('type') not in ('systemd_ownership','ready','started','child_output','terminal') or f.get('type')=='child_output' and not indexes[2]<i<indexes[3] for i,f in enumerate(frames)):return False
        start_request(frames[:2],frames[1],before)
        if not resource.same(report['terminal'],frames[-1]):return False
        return resource.evaluate(report,SCENARIO) is True
    except (ValueError,TypeError,KeyError,AttributeError,OSError,RecursionError):return False


def main():
    if sys.argv[1:]:raise ValueError('FIXED_SYSTEMD_REFUSAL_NO_ARGUMENTS')
    basic,resource,driver=stack();original_hashes=driver.source_hashes
    def hashes():
        values=original_hashes()
        if any(values.get(p)!=h for p,h in driver.composedSources.items()):raise ValueError('SYSTEMD_REFUSAL_COMPOSED_SOURCE_DRIFT')
        return values
    driver.source_hashes=hashes
    base=basic.load(basic.BASE);base_sha=base.loadedSha
    class Wire(base.ObservedWire):
        def admit_start(self,ready,before,original):
            if before.get(basic.BASE)!=base_sha:raise ValueError('SYSTEMD_REFUSAL_WIRE_SOURCE_DRIFT')
            return start_request(self.frames,ready,before)
    resource.SCENARIO=SCENARIO;resource.ObservedWire=Wire
    resource.select_scenario=lambda args:SCENARIO if not args else (_ for _ in ()).throw(ValueError('FIXED_NO_ARGUMENTS'))
    resource.evaluate=lambda report,scenario=SCENARIO:scenario==SCENARIO and evaluate(report)
    return resource.main()


if __name__=='__main__':raise SystemExit(main())
