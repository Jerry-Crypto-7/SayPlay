"""Read-only actual EventReader leaf ancestry binding; no CLI or workload."""
import copy
import hashlib
import json
import math
import re
import stat
import time
import types

FILES=('subscription-cgroup-common-view.py','subscription-candidate-resource-events.py')
MAX_REPORT=2*1024*1024
_UNKNOWN=False


def require(value,reason='TARGET_ANCESTRY_INVALID'):
    if not value:raise ValueError(reason)
def encode(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def same(a,b):return encode(a)==encode(b)
def check(deadline):require(time.monotonic()<deadline,'TARGET_ANCESTRY_DEADLINE')
def exact(value,keys):return type(value) is dict and set(value)==set(keys)
def number(value,minimum=0):return type(value) is int and minimum<=value<=9007199254740991
def valid_hashes(value):return exact(value,FILES) and all(type(v) is str and re.fullmatch('[a-f0-9]{64}',v) for v in value.values())


def load_dependencies(raw,expected_hashes):
    require(valid_hashes(expected_hashes) and exact(raw,FILES),'TARGET_ANCESTRY_SOURCE_KEYS')
    result=[]
    for name in FILES:
        data=raw[name]
        require(type(data) is bytes and 0<len(data)<=1048576 and hashlib.sha256(data).hexdigest()==expected_hashes[name],
                'TARGET_ANCESTRY_SOURCE_HASH')
        module=types.ModuleType('private_target_'+name.replace('-','_'))
        module.__file__='/mnt/d/claude/Hackaton/scripts/'+name
        exec(compile(data,module.__file__,'exec'),module.__dict__)
        module.__source_sha256__=expected_hashes[name];result.append(module)
    return tuple(result)


def dependency_hashes(deps):
    require(type(deps) is tuple and len(deps)==2,'TARGET_ANCESTRY_DEPENDENCIES')
    value={name:module.__source_sha256__ for name,module in zip(FILES,deps)}
    require(valid_hashes(value),'TARGET_ANCESTRY_DEPENDENCIES');return value


def directory_from_event(value):
    require(exact(value,('dev','ino','mode')) and all(number(v) for v in value.values()) and value['ino']>0
            and stat.S_IFMT(value['mode'])==stat.S_IFDIR,'TARGET_ANCESTRY_LEAF_IDENTITY')
    return {'dev':value['dev'],'ino':value['ino'],'type':stat.S_IFDIR}


def common_identity(a,b,sampler):
    require(sampler.validate_self_report(a) is True and sampler.validate_self_report(b) is True,'TARGET_ANCESTRY_VIEW')
    require(same(a['selfIdentity'],b['selfIdentity']) and a['uid']==b['uid'] and a['membership']==b['membership'],
            'TARGET_ANCESTRY_SELF_DRIFT')
    for name in ('mountinfo','cgroup'):
        require(a['after']['proc'][name]['sha256']==b['before']['proc'][name]['sha256'],'TARGET_ANCESTRY_MOUNT_DRIFT')
    require(same(a['mount'],b['mount']),'TARGET_ANCESTRY_MOUNT_DRIFT')
    for path in [sampler.ROOT]+sampler.ancestors(a['uid']):
        require(same(a['directories'][path],b['directories'][path]),'TARGET_ANCESTRY_PARENT_DRIFT')


def bind_target(reader,common_snapshot,absolute_deadline,deps):
    global _UNKNOWN
    require(not _UNKNOWN,'PRIOR_TARGET_ANCESTRY_UNKNOWN')
    sampler,events=deps;hashes=dependency_hashes(deps)
    require(type(reader) is events.EventReader,'TARGET_ANCESTRY_FACTORY_READER')
    require(reader._opened is True and reader._closed is False and reader._failed is False
            and type(reader._directory) is int,'TARGET_ANCESTRY_READER_NOT_OPEN')
    require(type(absolute_deadline) in (int,float) and math.isfinite(absolute_deadline)
            and 0<absolute_deadline-time.monotonic()<=5,'TARGET_ANCESTRY_FIXED_DEADLINE')
    deadline=min(absolute_deadline,reader.deadline)
    check(deadline);_UNKNOWN=True
    kernel=sampler.Kernel();owned=[];view=None;result=None;failure=None
    try:
        began=time.monotonic();uid=kernel.uid();unit=reader.unit
        require(type(unit) is str and re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',unit),'TARGET_ANCESTRY_UNIT')
        parents=[sampler.ROOT]+sampler.ancestors(uid);leaf=parents[-1]+'/'+unit
        require(reader._path==leaf,'TARGET_ANCESTRY_FACTORY_PATH')
        require(sampler.validate_self_report(common_snapshot) is True and
                0<=began-common_snapshot['sealedMonotonic']<5,'TARGET_ANCESTRY_FRESH_COMMON_VIEW')
        view=sampler.open_self_view(deadline);before=view.sample()
        common_identity(common_snapshot,before,sampler)
        event_before=reader.sample();check(deadline)
        require(event_before['unit']==unit and event_before['leaf']==leaf,'TARGET_ANCESTRY_EVENT_UNIT')
        leaf_identity=directory_from_event(event_before['directory'])
        require(kernel.info(reader._directory)==leaf_identity and kernel.filesystem(reader._directory)==sampler.CGROUP2,
                'TARGET_ANCESTRY_RETAINED_LEAF')
        directories={}
        for path in parents+[leaf]:
            check(deadline);fd=kernel.walk(path,deadline);owned.append(fd)
            identity=kernel.info(fd);filesystem=kernel.filesystem(fd)
            require(sampler.valid_identity(identity,stat.S_IFDIR) and filesystem==sampler.CGROUP2,'TARGET_ANCESTRY_FILESYSTEM')
            expected=leaf_identity if path==leaf else before['directories'][path]['identity']
            require(same(identity,expected),'TARGET_ANCESTRY_DIRECTORY_MISMATCH')
            directories[path]={'identity':identity,'filesystemType':filesystem}
        after=view.sample();common_identity(before,after,sampler)
        event_after=reader.sample();check(deadline)
        require(same(event_before['directory'],event_after['directory']) and event_after['unit']==unit
                and event_after['leaf']==leaf,'TARGET_ANCESTRY_LEAF_REPLACED')
        require(kernel.info(reader._directory)==leaf_identity and kernel.filesystem(reader._directory)==sampler.CGROUP2,
                'TARGET_ANCESTRY_RETAINED_LEAF')
        for path,fd in zip(parents+[leaf],owned):
            require(same(kernel.info(fd),directories[path]['identity']) and kernel.filesystem(fd)==sampler.CGROUP2,
                    'TARGET_ANCESTRY_RETAINED_PATH_CHANGED')
        result={'version':1,'kind':'OWN_EVENT_READER_TARGET_ANCESTRY','sourceSha256':hashes,'unit':unit,'leaf':leaf,
            'commonSnapshot':copy.deepcopy(common_snapshot),'observerBefore':before,'observerAfter':after,
            'eventBefore':event_before,'eventAfter':event_after,'directories':directories,'startedMonotonic':began,
            'localHandlesClosed':False,'eventReaderClosedHere':False,'releaseAdmitted':False,'exhaustionValidated':False,
            'hostInitialNamespaceAttested':False,'managerNamespaceAttested':False}
    except BaseException as error:failure=error
    finally:
        for fd in reversed(owned):
            try:kernel.close_known(fd)
            except BaseException as error:failure=failure or error
        if view is not None:
            try:require(view.close() is True,'TARGET_ANCESTRY_VIEW_CLOSE')
            except BaseException as error:failure=failure or error
    if failure is not None:raise failure
    result['localHandlesClosed']=True;result['sealedMonotonic']=time.monotonic()
    require(validate_report(result,hashes,deps),'TARGET_ANCESTRY_REPLAY')
    require(len(encode(result))<=MAX_REPORT,'TARGET_ANCESTRY_REPORT_BOUND');check(deadline)
    _UNKNOWN=False
    return result


def validate_event(value,events):
    require(exact(value,('version','unit','leaf','directory','observerCgroup','sequence','monotonic','sealedMonotonic',
        'values','files','unitCleanupAttestedHere','exhaustionValidatedHere')),'TARGET_ANCESTRY_EVENT_SHAPE')
    require(type(value['version']) is int and value['version']==1 and number(value['sequence'],1)
            and value['unitCleanupAttestedHere'] is False and value['exhaustionValidatedHere'] is False,'TARGET_ANCESTRY_EVENT_FLAGS')
    directory=directory_from_event(value['directory'])
    require(exact(value['values'],events.FILES) and exact(value['files'],events.FILES),'TARGET_ANCESTRY_EVENT_FILES')
    for name in events.FILES:
        record=value['files'][name]
        if record=={'available':False,'errno':2}:
            require(same(record,{'available':False,'errno':2}) and name in events.OPTIONAL and value['values'][name] is None,'TARGET_ANCESTRY_OPTIONAL')
            continue
        require(exact(record,('available','identity','bytes','sha256','rawHex')) and record['available'] is True,'TARGET_ANCESTRY_RAW_RECORD')
        raw=bytes.fromhex(record['rawHex']);identity=record['identity']
        require(raw.hex()==record['rawHex'] and number(record['bytes'],1) and len(raw)==record['bytes']<=events.MAX_FILE_BYTES
                and hashlib.sha256(raw).hexdigest()==record['sha256'],'TARGET_ANCESTRY_RAW_HASH')
        require(exact(identity,('dev','ino','mode')) and all(number(v) for v in identity.values()) and identity['ino']>0
            and identity['dev']==directory['dev'] and stat.S_IFMT(identity['mode'])==stat.S_IFREG,'TARGET_ANCESTRY_FILE_IDENTITY')
        require(same(events.parse_file(name,raw),value['values'][name]),'TARGET_ANCESTRY_RAW_PARSE')
    require(all(type(value['values'][k]) is int and value['values'][k]==v for k,v in events.LIMITS.items()),'TARGET_ANCESTRY_LIMITS')
    require(value['values']['pids.current']<=64,'TARGET_ANCESTRY_TASKS')
    require(all(type(value[k]) in (int,float) and math.isfinite(value[k]) for k in ('monotonic','sealedMonotonic'))
            and 0<=value['monotonic']<=value['sealedMonotonic'],'TARGET_ANCESTRY_EVENT_TIME')


def validate_report(report,expected_hashes,deps):
    try:
        sampler,events=deps
        require(valid_hashes(expected_hashes) and same(report['sourceSha256'],expected_hashes),'TARGET_ANCESTRY_SOURCE')
        require(exact(report,('version','kind','sourceSha256','unit','leaf','commonSnapshot','observerBefore','observerAfter',
            'eventBefore','eventAfter','directories','startedMonotonic','sealedMonotonic','localHandlesClosed','eventReaderClosedHere',
            'releaseAdmitted','exhaustionValidated','hostInitialNamespaceAttested','managerNamespaceAttested')),'TARGET_ANCESTRY_REPORT')
        require(type(report['version']) is int and report['version']==1 and report['kind']=='OWN_EVENT_READER_TARGET_ANCESTRY'
            and report['localHandlesClosed'] is True and all(report[k] is False for k in ('eventReaderClosedHere','releaseAdmitted',
                'exhaustionValidated','hostInitialNamespaceAttested','managerNamespaceAttested')),'TARGET_ANCESTRY_CREDIT')
        a,b=report['observerBefore'],report['observerAfter'];common_identity(report['commonSnapshot'],a,sampler);common_identity(a,b,sampler)
        parents=[sampler.ROOT]+sampler.ancestors(a['uid']);unit=report['unit'];leaf=parents[-1]+'/'+unit
        require(type(unit) is str and re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',unit) and report['leaf']==leaf,'TARGET_ANCESTRY_UNIT')
        require(exact(report['directories'],parents+[leaf]),'TARGET_ANCESTRY_PATHS')
        first,last=report['eventBefore'],report['eventAfter'];validate_event(first,events);validate_event(last,events)
        for event in (first,last):
            require(event['unit']==unit and event['leaf']==leaf and event['observerCgroup']==a['membership'],'TARGET_ANCESTRY_MEMBERSHIP')
        require(last['sequence']==first['sequence']+1 and same(first['directory'],last['directory']),'TARGET_ANCESTRY_SEQUENCE')
        require(a['membership']!=leaf.removeprefix(sampler.ROOT) and not a['membership'].startswith(leaf.removeprefix(sampler.ROOT)+'/'),'TARGET_ANCESTRY_OUTSIDE')
        for name in events.FILES:
            x,y=first['files'][name],last['files'][name]
            require(x['available'] is y['available'],'TARGET_ANCESTRY_SUPPORT_DRIFT')
            if x['available']:require(same(x['identity'],y['identity']),'TARGET_ANCESTRY_FILE_DRIFT')
        for name in events.COUNTERS:
            x,y=first['values'][name],last['values'][name]
            require(x is None and y is None or type(x) is dict and type(y) is dict and set(x)==set(y)
                    and all(y[k]>=v for k,v in x.items()),'TARGET_ANCESTRY_COUNTER_RESET')
        for path,item in report['directories'].items():
            require(exact(item,('identity','filesystemType')) and sampler.valid_identity(item['identity'],stat.S_IFDIR)
                and type(item['filesystemType']) is int and item['filesystemType']==sampler.CGROUP2,'TARGET_ANCESTRY_FS')
            expected=directory_from_event(first['directory']) if path==leaf else a['directories'][path]['identity']
            require(same(item['identity'],expected),'TARGET_ANCESTRY_IDENTITY')
            require(sampler.device_numbers(item['identity']['dev'])==(a['mount']['major'],a['mount']['minor']),'TARGET_ANCESTRY_DEVICE')
        times=[report['commonSnapshot']['sealedMonotonic'],report['startedMonotonic'],a['startedMonotonic'],a['sealedMonotonic'],
               first['monotonic'],first['sealedMonotonic'],b['startedMonotonic'],b['sealedMonotonic'],
               last['monotonic'],last['sealedMonotonic'],report['sealedMonotonic']]
        require(all(type(v) in (int,float) and math.isfinite(v) for v in times) and times==sorted(times)
                and 0<=times[1]-times[0]<5 and 0<=times[-1]-times[1]<5,'TARGET_ANCESTRY_TIME')
        require(len(encode(report))<=MAX_REPORT,'TARGET_ANCESTRY_BOUND');return True
    except (ValueError,TypeError,KeyError,IndexError,AttributeError,OverflowError):return False


if __name__=='__main__':raise SystemExit('TRUSTED_OWN_EVENT_READER_COMPOSITION_REQUIRED')
