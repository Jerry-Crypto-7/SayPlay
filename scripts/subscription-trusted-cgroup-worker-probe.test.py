"""Mocked open-only observations. No cgroup access or writes in these tests."""
import copy
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


m=load('subscription-trusted-cgroup-worker-probe')
fixture=load('subscription-trusted-control-boundary-probe.test')
BASE_HASH=hashlib.sha256(Path(__file__).with_name('subscription-trusted-control-boundary-probe.py').read_bytes()).hexdigest()


def complete_report():
    base=fixture.report()
    ns={k:base['identity'][k] for k in ('pidNamespace','mountNamespace','procInitPidNamespace')}
    return {'version':1,'kind':'FIXED_CGROUP_WRITE_OPEN_OBSERVATIONS','baseSha256':BASE_HASH,'baseReport':base,'flags':m.FLAGS,
        'paths':{path:{'opened':False,'errno':code,'outcome':{1:'denied',2:'absent',13:'denied',30:'readonly'}[code],
            'descriptor':None,'metadataError':None,'cleanup':'NOT_CREATED','bytesRead':0,'bytesWritten':0}
            for path,code in zip(m.PATHS,(1,2,13,30))},
        'descriptorsBefore':copy.deepcopy(base['descriptors']),'descriptorsAfter':copy.deepcopy(base['descriptors']),
        'namespacesBefore':copy.deepcopy(ns),'namespacesAfter':copy.deepcopy(ns),'bytesReadFromCgroup':0,'bytesWrittenToCgroup':0,
        'migrationAttempted':False,'mountAttempted':False,'productionReady':False,'cleanupAttestedHere':False}


def test_complete_mixed_mechanisms_remain_distinct():
    report=complete_report()
    assert m.validate_report_with(fixture.m,report,fixture.marker(),BASE_HASH)
    assert {x['outcome'] for x in report['paths'].values()}=={'denied','absent','readonly'}


@pytest.fixture
def flags(monkeypatch):
    for name,value in {'O_WRONLY':1,'O_CLOEXEC':524288,'O_NONBLOCK':2048,'O_NOFOLLOW':131072,'O_CREAT':64,'O_TRUNC':512}.items():
        monkeypatch.setattr(m.os,name,value,raising=False)
    monkeypatch.setattr(m.os,'read',lambda *a:pytest.fail('no cgroup read'))
    monkeypatch.setattr(m.os,'write',lambda *a:pytest.fail('no cgroup write'))


@pytest.mark.parametrize('code,outcome',[(1,'denied'),(13,'denied'),(2,'absent'),(30,'readonly'),(22,'unknown'),(12,'unknown')])
def test_open_error_is_explicit_and_no_write(monkeypatch,flags,code,outcome):
    calls=[]
    def opened(path,open_flags):
        calls.append((path,open_flags));raise OSError(code,'mock')
    monkeypatch.setattr(m.os,'open',opened)
    r=m.write_open_only(m.PATHS[0])
    assert r['outcome']==outcome and r['errno']==code and r['cleanup']=='NOT_CREATED'
    assert calls==[(m.PATHS[0],1|524288|2048|131072)]
    assert not calls[0][1]&(64|512)


@pytest.mark.parametrize('close_failure,stat_failure',[(False,False),(True,False),(False,True)])
def test_successful_open_always_rejected_even_with_zero_writes(monkeypatch,flags,close_failure,stat_failure):
    closed=[]
    monkeypatch.setattr(m.os,'open',lambda *a:9)
    def info(fd):
        if stat_failure:raise OSError(5,'mock stat')
        return SimpleNamespace(st_dev=1,st_ino=900,st_mode=0o100000)
    def close(fd):
        closed.append(fd)
        if close_failure:raise OSError(5,'mock close')
    monkeypatch.setattr(m.os,'fstat',info);monkeypatch.setattr(m.os,'close',close)
    r=m.write_open_only(m.PATHS[0]);assert r['opened'] is True and closed==[9]
    assert r['cleanup']==('UNKNOWN' if close_failure else 'CLOSED')
    assert r['bytesRead']==r['bytesWritten']==0
    full=complete_report();full['paths'][m.PATHS[0]]=r
    assert not m.validate_report_with(fixture.m,full,fixture.marker(),BASE_HASH)


@pytest.mark.parametrize('case',['bool-errno','unknown-errno','unknown-cleanup','missing-path','extra-path','wrong-flags','written','bool-zero','base-hash','base-private-home','fd-leak','namespace-drift','wrong-mechanism','false-completion'])
def test_strict_full_replay_negatives(case):
    r=complete_report();path=m.PATHS[0]
    if case=='bool-errno':r['paths'][path]['errno']=True
    elif case=='unknown-errno':r['paths'][path]['errno']=22;r['paths'][path]['outcome']='unknown'
    elif case=='unknown-cleanup':r['paths'][path]['cleanup']='UNKNOWN'
    elif case=='missing-path':r['paths'].pop(path)
    elif case=='extra-path':r['paths']['/foreign/cgroup.procs']=copy.deepcopy(r['paths'][path])
    elif case=='wrong-flags':r['flags']='O_RDONLY'
    elif case=='written':r['paths'][path]['bytesWritten']=1
    elif case=='bool-zero':r['bytesWrittenToCgroup']=False
    elif case=='base-hash':r['baseSha256']='0'*64
    elif case=='base-private-home':r['baseReport']['paths'][fixture.m.PROTECTED_PATHS[0]]=fixture.opened()
    elif case=='fd-leak':r['descriptorsAfter'].append({'fd':9,'dev':1,'ino':900,'type':0o100000})
    elif case=='namespace-drift':r['namespacesAfter']['procInitPidNamespace']='pid:[10]'
    elif case=='wrong-mechanism':r['paths'][path]['outcome']='absent'
    elif case=='false-completion':r['paths'][path]['opened']=0
    assert not m.validate_report_with(fixture.m,r,fixture.marker(),BASE_HASH)


def test_arbitrary_path_never_opened(monkeypatch,flags):
    monkeypatch.setattr(m.os,'open',lambda *a:pytest.fail('foreign path opened'))
    with pytest.raises(ValueError,match='FIXED_CGROUP_PATH_REQUIRED'):m.write_open_only('/sys/fs/cgroup/foreign/memory.max')


def test_collect_samples_inventory_around_four_fixed_operations(monkeypatch):
    r=complete_report();events=[]
    fakebase=SimpleNamespace(collect=lambda:r['baseReport'])
    monkeypatch.setattr(m,'inventory',lambda base:events.append('inventory') or copy.deepcopy(r['descriptorsBefore']))
    monkeypatch.setattr(m,'namespaces',lambda:copy.deepcopy(r['namespacesBefore']))
    monkeypatch.setattr(m,'write_open_only',lambda path:events.append(path) or copy.deepcopy(r['paths'][path]))
    actual=m.collect_with(fakebase,BASE_HASH)
    assert events==['inventory',*m.PATHS,'inventory']
    assert m.validate_report_with(fixture.m,actual,fixture.marker(),BASE_HASH)
