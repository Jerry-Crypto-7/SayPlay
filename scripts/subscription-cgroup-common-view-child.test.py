import hashlib
import importlib.util
import json
from pathlib import Path
import types

import pytest


@pytest.fixture
def child():
    path=Path(__file__).with_name('subscription-cgroup-common-view-child.py')
    module=types.ModuleType('common_view_child_test');module.__file__=str(path)
    exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__)
    return module


def setup_run(monkeypatch,child,release=b'{"type":"common_view_release"}\n'):
    raw={child.FILES[0]:b'def sample_self(deadline):\n return {"sample": True}\n',child.FILES[1]:b'fixed'}
    hashes={n:hashlib.sha256(v).hexdigest() for n,v in raw.items()}
    admission=json.dumps({'type':'common_view_sample','sourceSha256':hashes}).encode()+b'\n'
    lines=iter([admission,release]);output=[]
    monkeypatch.setattr(child,'_sources',lambda deadline:raw)
    monkeypatch.setattr(child,'_line',lambda *args:next(lines))
    monkeypatch.setattr(child,'_write',lambda fd,data,deadline:output.append(data))
    monkeypatch.setattr(child.os,'set_blocking',lambda *args:None)
    return raw,output


def test_fixed_sample_held_until_release(child,monkeypatch):
    _,output=setup_run(monkeypatch,child)
    assert child.run()==0
    report=json.loads(output[0]);assert report['observation']=={'sample':True}
    assert report['productionReady'] is False and report['modelCalls']==0
    assert len(output)==1


@pytest.mark.parametrize('release',[b'{}\n',b'{"type":"common_view_release","path":"/"}\n',b'{ "type":"common_view_release"}\n'])
def test_release_is_fixed_bytes(child,monkeypatch,release):
    setup_run(monkeypatch,child,release)
    with pytest.raises(ValueError,match='FIXED_RELEASE'):child.run()


def test_source_drift_before_output(child,monkeypatch):
    raw,output=setup_run(monkeypatch,child)
    alternate=dict(raw);alternate[child.FILES[1]]=b'changed'
    sequence=iter([raw,alternate]);monkeypatch.setattr(child,'_sources',lambda _:next(sequence))
    with pytest.raises(ValueError,match='SOURCE_AFTER_DRIFT'):child.run()
    assert output==[]


def test_unknown_blocks_before_admission(child,monkeypatch):
    child._UNKNOWN=True
    monkeypatch.setattr(child,'_line',lambda *_:pytest.fail('dispatch'))
    with pytest.raises(ValueError,match='PRIOR_CLOSE_UNKNOWN'):child.run()


def test_no_argument_override(child,monkeypatch):
    monkeypatch.setattr(child.sys,'argv',['child','--path=/'])
    with pytest.raises(ValueError,match='NO_ARGUMENTS'):child.main()


@pytest.mark.parametrize('raw',[b'{"a":1,"a":2}',b'{"a":NaN}'])
def test_strict_json(child,raw):
    with pytest.raises(ValueError):child._json(raw)


def test_control_limit_and_no_overread(child,monkeypatch):
    data=iter(b'ab\nZ');reads=[]
    monkeypatch.setattr(child.select,'select',lambda *_:([0],[],[]))
    def read(fd,n):reads.append(n);return bytes([next(data)])
    monkeypatch.setattr(child.os,'read',read)
    assert child._line(0,child.time.monotonic()+1,3)==b'ab\n'
    assert reads==[1,1,1] and next(data)==ord('Z')


def test_control_overflow(child,monkeypatch):
    monkeypatch.setattr(child.select,'select',lambda *_:([0],[],[]))
    monkeypatch.setattr(child.os,'read',lambda *_:b'x')
    with pytest.raises(ValueError,match='CONTROL_LIMIT'):child._line(0,child.time.monotonic()+1,3)


def test_output_partial_and_backpressure(child,monkeypatch):
    counts=iter([BlockingIOError(),2,1]);sent=[]
    monkeypatch.setattr(child.select,'select',lambda *_:([],[1],[]))
    def write(fd,data):
        result=next(counts)
        if isinstance(result,Exception):raise result
        sent.append(data[:result]);return result
    monkeypatch.setattr(child.os,'write',write)
    child._write(1,b'abc',child.time.monotonic()+1)
    assert b''.join(sent)==b'abc'


def test_report_bound(child,monkeypatch):
    _,output=setup_run(monkeypatch,child);child.MAX_REPORT=1
    with pytest.raises(ValueError,match='REPORT_LIMIT'):child.run()
    assert output==[]


def test_failed_sample_fences_second_run(child,monkeypatch):
    raw,_=setup_run(monkeypatch,child)
    monkeypatch.setattr(child,'_sources',lambda _:(_ for _ in ()).throw(OSError('close unknown')))
    with pytest.raises(OSError):child.run()
    assert child._UNKNOWN is True
    with pytest.raises(ValueError,match='PRIOR_CLOSE_UNKNOWN'):child.run()


@pytest.mark.parametrize('kind,size',[(0o010000,0),(0o040000,0),(0o100000,1048577)])
def test_sources_nonblocking_admission_before_read(child,monkeypatch,kind,size):
    for name,value in [('O_CLOEXEC',0x10000),('O_NOFOLLOW',0x20000),('O_NONBLOCK',0x40000)]:
        monkeypatch.setattr(child.os,name,value,raising=False)
    opened=[];closed=[]
    monkeypatch.setattr(child.os,'open',lambda path,flags:(opened.append(flags) or 91))
    monkeypatch.setattr(child.os,'fstat',lambda _:types.SimpleNamespace(st_mode=kind,st_size=size))
    monkeypatch.setattr(child.os,'read',lambda *_:pytest.fail('read before admission'))
    monkeypatch.setattr(child.os,'close',lambda fd:closed.append(fd))
    with pytest.raises(ValueError,match='SOURCE_(REGULAR|SIZE)'):child._sources(child.time.monotonic()+1)
    assert opened[0]&child.os.O_NONBLOCK and closed==[91]
