"""Fake-kernel only; no host PID inventory or network operation."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest

spec=importlib.util.spec_from_file_location('provenance',Path(__file__).with_name('subscription-cli-proxy-provenance.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
RAW_READ=m.Observer.read


def observation():return {'peer':['127.0.0.1',41000],'local':['127.0.0.1',42000],'socket':{'dev':9,'ino':777,'type':49152}}
def stat(pid=123,ticks='900'):
    fields=['S']+['0']*18+[ticks]
    return (str(pid)+' (own worker) '+' '.join(fields)+'\n').encode()
def tcp(inode=555,reverse=False,state='01'):
    a,b=('A410','A028') if reverse else ('A028','A410')
    return f'  sl local_address rem_address st\n 0: 0100007F:{a} 0100007F:{b} {state} 00000000:00000000 00:00000000 00000000 1000 0 {inode}\n'.encode()


@pytest.fixture
def kernel(monkeypatch):
    clock=[10.0];closed=[];links=[];signals=[]
    monkeypatch.setattr(m,'_FENCED',False);monkeypatch.setattr(m.time,'monotonic',lambda:clock[0])
    monkeypatch.setattr(m.signal,'pidfd_send_signal',lambda fd,sig:signals.append((fd,sig)),raising=False)
    monkeypatch.setattr(m.os,'dup',lambda fd:88);monkeypatch.setattr(m.os,'set_inheritable',lambda fd,v:None)
    monkeypatch.setattr(m.os,'get_inheritable',lambda fd:False);monkeypatch.setattr(m.os,'close',lambda fd:closed.append(fd))
    def readlink(path):
        links.append(path)
        return 'socket:[555]' if path.endswith('/fd/4') else '/dev/null' if '/fd/' in path else 'net:[1234]'
    monkeypatch.setattr(m.os,'readlink',readlink)
    class Entries:
        def __init__(self):self.items=iter([SimpleNamespace(name=str(n)) for n in (0,1,2,4)])
        def __next__(self):return next(self.items)
        def close(self):pass
    monkeypatch.setattr(m.os,'scandir',lambda p:Entries())
    monkeypatch.setattr(m.Observer,'read',lambda self,path,limit:stat() if path.endswith('/stat') else tcp())
    process=SimpleNamespace(pid=123,poll=lambda:None)
    observer=m.create_observer(process,77,'900','net:[1234]',12.0)
    return SimpleNamespace(observer=observer,process=process,clock=clock,closed=closed,links=links,signals=signals)


def test_two_real_observer_calls_and_pure_replay_of_fake_kernel(kernel):
    o=kernel.observer;a=o(m.PHASES[0],observation());kernel.clock[0]=10.5;b=o(m.PHASES[1],observation())
    assert m.validate_records([a,b],{'pid':123,'startTicks':'900','networkNamespace':'net:[1234]'},observation())
    assert a['clientInode']==555 and a['clientInode']!=a['observation']['socket']['ino'] and a['holders']==[4]
    assert all(p in ('/proc/123/ns/net','/proc/self/ns/net') or p.startswith('/proc/123/fd/') for p in kernel.links)
    assert all(sig==0 for _,sig in kernel.signals)
    a['holders'].append(9);assert o.records[0]['holders']==[4]
    assert o.close()['closed'] and o.close()['closed'] and kernel.closed==[88]


@pytest.mark.parametrize('case',['wrong-first','repeat','peer-change','socket-change','deadline','exit','generation','network','inode','missing-holder','fd-limit'])
def test_phase_race_identity_and_shared_deadline_failures_fence(kernel,monkeypatch,case):
    o=kernel.observer;obs=observation()
    if case=='repeat':o(m.PHASES[0],obs)
    elif case in ('peer-change','socket-change','inode'):o(m.PHASES[0],obs)
    if case=='peer-change':obs['peer'][1]+=1
    if case=='socket-change':obs['socket']['ino']+=1
    if case=='deadline':kernel.clock[0]=12
    if case=='exit':kernel.process.poll=lambda:0
    if case=='generation':monkeypatch.setattr(o,'read',lambda p,n:stat(ticks='901'))
    if case=='network':monkeypatch.setattr(m.os,'readlink',lambda p:'net:[999]')
    if case=='inode':monkeypatch.setattr(o,'read',lambda p,n:stat() if p.endswith('/stat') else tcp(556))
    if case=='missing-holder':monkeypatch.setattr(m.os,'readlink',lambda p:'/dev/null' if '/fd/' in p else 'net:[1234]')
    if case=='fd-limit':
        class Many:
            def __init__(self):self.i=iter(range(257))
            def __next__(self):return SimpleNamespace(name=str(next(self.i)))
            def close(self):pass
        monkeypatch.setattr(m.os,'scandir',lambda p:Many())
    phase=m.PHASES[1] if case in ('wrong-first','peer-change','socket-change','inode') else m.PHASES[0]
    with pytest.raises(ValueError):o(phase,obs)
    assert m._FENCED
    with pytest.raises(ValueError,match='GLOBAL_FENCE'):m.create_observer(kernel.process,77,'900','net:[1234]',12)


@pytest.mark.parametrize('raw',[tcp(reverse=True),tcp(state='02'),tcp(0),tcp()+tcp().split(b'\n',1)[1],b'x'*65537,
    b'sl local_address\n'+tcp().split(b'\n',1)[1]*257],ids=['reverse','not-established','zero-inode','duplicate','bytes-limit','rows-limit'])
def test_unique_client_side_established_row_and_caps(raw):
    with pytest.raises(ValueError):m.client_inode(raw,observation())


def test_close_failure_never_retries_possibly_reused_fd(kernel,monkeypatch):
    calls=[]
    def close(fd):calls.append(fd);raise OSError('close')
    monkeypatch.setattr(m.os,'close',close)
    assert not kernel.observer.close()['closed'] and not kernel.observer.close()['closed']
    assert calls==[88] and m._FENCED


def test_after_io_deadline_rejects_before_record(kernel,monkeypatch):
    original=m.os.readlink
    def delayed(path):
        result=original(path);kernel.clock[0]=12;return result
    monkeypatch.setattr(m.os,'readlink',delayed)
    with pytest.raises(ValueError,match='DEADLINE'):kernel.observer(m.PHASES[0],observation())
    assert kernel.observer.records==[]


@pytest.mark.parametrize('case',['bool-version','extra','wrong-generation','same-server-inode','tcp-hash','holder-bool','holder-duplicate','phase','deadline','observation','stat-hash'])
def test_replay_rejects_tampered_evidence(kernel,case):
    o=kernel.observer;records=[o(m.PHASES[0],observation()),o(m.PHASES[1],observation())];r=records[1]
    if case=='bool-version':r['version']=True
    if case=='extra':r['extra']=1
    if case=='wrong-generation':r['identityAfter']['startTicks']='901'
    if case=='same-server-inode':r['clientInode']=777
    if case=='tcp-hash':r['tcpSha256']='0'*64
    if case=='holder-bool':r['holders']=[True]
    if case=='holder-duplicate':r['holders']=[4,4]
    if case=='phase':r['phase']=m.PHASES[0]
    if case=='deadline':r['capturedMonotonic']=r['deadlineMonotonic']
    if case=='observation':r['observation']['local'][1]+=1
    if case=='stat-hash':r['identityBefore']['statSha256']='0'*64
    assert not m.validate_records(records,{'pid':123,'startTicks':'900','networkNamespace':'net:[1234]'},observation())


def test_client_inode_never_aliases_accepted_server_socket():
    with pytest.raises(ValueError,match='SOCKET_ALIAS'):m.client_inode(tcp(777),observation())


@pytest.mark.parametrize('case',['over-limit','read-error','late-open','valid'])
def test_raw_metadata_read_closes_only_opened_handle_and_keeps_bounds(kernel,monkeypatch,case):
    for name,value in [('O_CLOEXEC',0x80000),('O_NOFOLLOW',0x20000),('O_NONBLOCK',0x800)]:monkeypatch.setattr(m.os,name,value,raising=False)
    opened=[];calls=[]
    def open_(path,flags):
        opened.append((path,flags))
        if case=='late-open':kernel.clock[0]=12
        return 91
    chunks=iter([b'x'*5,b''])
    def read_(fd,size):
        calls.append((fd,size))
        if case=='read-error':raise OSError('own proc read')
        return next(chunks)
    monkeypatch.setattr(m.os,'open',open_);monkeypatch.setattr(m.os,'read',read_)
    if case=='valid':assert RAW_READ(kernel.observer,'/proc/123/stat',8)==b'xxxxx'
    else:
        with pytest.raises((ValueError,OSError)):RAW_READ(kernel.observer,'/proc/123/stat',4)
    assert kernel.closed==[91] and opened[0][1]&m.os.O_NONBLOCK
    assert 77 not in kernel.closed and 88 not in kernel.closed
    if case=='late-open':assert not calls


def test_factory_deadline_after_dup_closes_duplicate_and_fences(kernel,monkeypatch):
    def duplicate(fd):kernel.clock[0]=12;return 99
    monkeypatch.setattr(m.os,'dup',duplicate)
    with pytest.raises(ValueError,match='DEADLINE'):m.create_observer(kernel.process,77,'900','net:[1234]',12)
    assert kernel.closed==[99] and m._FENCED


def test_fd_readlink_disappearance_is_failure_not_partial_holder_pass(kernel,monkeypatch):
    old=m.os.readlink
    def link(path):
        if path.endswith('/fd/2'):raise FileNotFoundError('own descriptor disappeared')
        return old(path)
    monkeypatch.setattr(m.os,'readlink',link)
    with pytest.raises(FileNotFoundError):kernel.observer(m.PHASES[0],observation())
    assert not kernel.observer.records and m._FENCED
