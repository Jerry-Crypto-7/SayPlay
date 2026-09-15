"""Real reader/sampler classes over authored kernels; no actual cgroup I/O."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import pytest


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=load('subscription-cgroup-target-ancestry.py')
sf=load('subscription-cgroup-common-view.test.py')
ef=load('subscription-candidate-resource-events.test.py')


def setup():
    events,event_kernel,reader=ef.setup();sampler=load('subscription-cgroup-common-view.py')
    event_kernel.outside=('0::'+sf.GROUP+'observer.scope\n').encode()
    fstat=events.os.fstat;stat=events.os.stat
    events.os.fstat=lambda fd:SimpleNamespace(**{**vars(fstat(fd)),'st_dev':51})
    events.os.stat=lambda *a,**kw:SimpleNamespace(**{**vars(stat(*a,**kw)),'st_dev':51})
    reader.open()
    kernel=sf.Kernel();info=kernel.info
    def identity(fd):
        if fd==reader._directory:return {'dev':51,'ino':88,'type':0o40000}
        if kernel.opened[fd]==reader._path:return {'dev':51,'ino':88,'type':0o40000}
        return info(fd)
    kernel.info=identity;sampler.Kernel=lambda:kernel;sampler.time=SimpleNamespace(monotonic=lambda:1)
    # Existing reader's module is the exact trusted dependency, not a subclass
    # or a second private compile with an incompatible EventReader identity.
    for name,module in zip(m.FILES,(sampler,events)):
        module.__source_sha256__=m.hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
    common=sf.report(now=1)
    return reader,common,(sampler,events),kernel,event_kernel


def complete_report():
    reader,common,deps,k,_=setup()
    with patch.object(m,'time',SimpleNamespace(monotonic=lambda:1)),patch.object(m,'_UNKNOWN',False):
        report=m.bind_target(reader,common,4,deps)
    reader.close()
    return report,m.dependency_hashes(deps),deps


def test_full_report_actual_classes_pure_replay_and_no_reader_ownership_transfer():
    reader,common,deps,k,_=setup();retained=reader._directory
    with patch.object(m,'time',SimpleNamespace(monotonic=lambda:1)),patch.object(m,'_UNKNOWN',False):
        report=m.bind_target(reader,common,4,deps)
        assert m.validate_report(report,m.dependency_hashes(deps),deps)
    assert reader._directory==retained and not reader._closed
    assert report['localHandlesClosed'] is True and report['eventReaderClosedHere'] is False
    assert not report['releaseAdmitted'] and not report['exhaustionValidated']
    assert report['eventAfter']['sequence']==report['eventBefore']['sequence']+1
    reader.close()


@pytest.mark.parametrize('case',['parent','leaf','overlay','raw','counter','sequence','source','time','credit','optional-bool'])
def test_pure_replay_rejects_cross_binding_and_raw_changes(case):
    report,hashes,deps=complete_report();leaf=report['leaf']
    if case=='parent':report['directories']['/sys/fs/cgroup']['identity']['ino']+=1
    elif case=='leaf':report['directories'][leaf]['identity']['ino']+=1
    elif case=='overlay':report['observerAfter']['mount']['root']='/changed'
    elif case=='raw':report['eventBefore']['files']['memory.max']['sha256']='b'*64
    elif case=='counter':report['eventAfter']['values']['memory.events']['oom']=99
    elif case=='sequence':report['eventAfter']['sequence']+=1
    elif case=='source':report['sourceSha256'][m.FILES[0]]='b'*64
    elif case=='time':report['sealedMonotonic']=7
    elif case=='credit':report['releaseAdmitted']=True
    elif case=='optional-bool':report['eventBefore']['files']['memory.events.local']={'available':0,'errno':2}
    assert m.validate_report(report,hashes,deps) is False


@pytest.mark.parametrize('case',['parent','leaf','filesystem','close','retained-replacement','overlay'])
def test_runtime_rejects_directory_change_and_unknown_cleanup(case):
    reader,common,deps,k,ek=setup();original_info=k.info;original_walk=k.walk;counter=[0]
    def info(fd):
        value=dict(original_info(fd))
        if case=='parent' and k.opened.get(fd)=='/sys/fs/cgroup':value['ino']+=1
        if case=='leaf' and k.opened.get(fd)==reader._path:value['ino']+=1
        if case=='retained-replacement' and fd==reader._directory:
            counter[0]+=1
            if counter[0]>1:value['ino']+=1
        return value
    def walk(path,deadline):
        fd=original_walk(path,deadline)
        if case=='close' and path==reader._path:k.close_error=fd
        return fd
    k.info=info;k.walk=walk
    if case=='filesystem':k.fs=123
    if case=='overlay':k.mount+=b'31 30 0:52 / /sys/fs/cgroup/user.slice rw - tmpfs tmpfs rw\n'
    with patch.object(m,'time',SimpleNamespace(monotonic=lambda:1)),patch.object(m,'_UNKNOWN',False):
        with pytest.raises((ValueError,OSError)):m.bind_target(reader,common,4,deps)
        assert m._UNKNOWN
        with pytest.raises(ValueError,match='PRIOR'):m.bind_target(reader,common,4,deps)
    assert reader._closed is False
    assert set(k.opened)<=set(k.closed)
    reader.close()


@pytest.mark.parametrize('case',['other-process','stale'])
def test_fresh_view_must_belong_to_current_observer(case):
    reader,common,deps,k,_=setup()
    if case=='other-process':common=sf.report(pid=303,now=1)
    else:common=sf.report(now=0)
    now=6 if case=='stale' else 1
    with patch.object(m,'time',SimpleNamespace(monotonic=lambda:now)),patch.object(m,'_UNKNOWN',False):
        with pytest.raises(ValueError):m.bind_target(reader,common,now+3,deps)
        assert m._UNKNOWN
    reader.close()


def test_source_compile_exact_hash_and_class_rejects_foreign_reader():
    raw={name:Path(__file__).with_name(name).read_bytes() for name in m.FILES}
    hashes={name:m.hashlib.sha256(data).hexdigest() for name,data in raw.items()}
    deps=m.load_dependencies(raw,hashes)
    assert m.dependency_hashes(deps)==hashes
    raw[m.FILES[0]]+=b'\n'
    with pytest.raises(ValueError,match='SOURCE_HASH'):m.load_dependencies(raw,hashes)
    with patch.object(m,'_UNKNOWN',False):
        with pytest.raises(ValueError,match='FACTORY_READER'):m.bind_target(SimpleNamespace(),{},4,deps)


def test_final_seal_delay_after_replay_stays_fenced():
    reader,common,deps,k,_=setup();clock=[1];validate=m.validate_report
    def delayed(*args):
        result=validate(*args);clock[0]=4;return result
    with patch.object(m,'time',SimpleNamespace(monotonic=lambda:clock[0])),patch.object(m,'_UNKNOWN',False),patch.object(m,'validate_report',delayed):
        with pytest.raises(ValueError,match='DEADLINE'):m.bind_target(reader,common,4,deps)
        assert m._UNKNOWN and not reader._closed
    reader.close()
