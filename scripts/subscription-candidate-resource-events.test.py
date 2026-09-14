import errno
import importlib.util
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import pytest


def module():
    path = Path(__file__).with_name('subscription-candidate-resource-events.py')
    spec = importlib.util.spec_from_file_location('private_candidate_events', path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class Kernel:
    def __init__(self, m):
        self.m = m
        self.next = 100
        self.handles = {}
        self.closed = []
        self.fail_close = set()
        self.replaced = set()
        self.missing = set()
        self.now = 1.0
        self.outside = b'0::/control.slice\n'
        self.directory_ino = 88
        self.contents = {name: str(value).encode()+b'\n' for name, value in m.LIMITS.items()}
        self.contents.update({'memory.events': b'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
            'memory.events.local': b'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
            'pids.events': b'max 0\n', 'cgroup.events': b'populated 1\nfrozen 0\n',
            'memory.current': b'123456\n', 'pids.current': b'5\n', 'cgroup.procs': b'101\n102\n'})
        proxy = SimpleNamespace(**{name:getattr(os, name, value) for name,value in {
            'O_RDONLY':0,'O_CLOEXEC':524288,'O_NOFOLLOW':131072,'O_NONBLOCK':2048,'O_DIRECTORY':65536,'SEEK_SET':0}.items()})
        for name in ('open','close','read','fstat','stat','lseek'):
            setattr(proxy, name, getattr(self, name))
        proxy.getuid = lambda:1000
        m.os = proxy
        m.time = SimpleNamespace(monotonic=lambda:self.now)
        m.uuid = SimpleNamespace(uuid4=lambda:SimpleNamespace(hex='a'*32))
        m.walk_directory = self.walk

    def allocate(self, name, ino):
        fd = self.next
        self.next += 1
        self.handles[fd] = (name, ino)
        return fd

    def walk(self, path):
        assert path == '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/codex-cli-resource-'+'a'*32+'.service'
        return self.allocate('directory', self.directory_ino)

    def open(self, name, flags, dir_fd=None):
        assert flags & self.m.os.O_CLOEXEC and flags & self.m.os.O_NOFOLLOW
        assert flags & 3 == self.m.os.O_RDONLY
        if name == '/proc/self/cgroup':
            assert dir_fd is None
            return self.allocate('self', 7)
        assert self.handles[dir_fd][0] == 'directory'
        assert name in self.m.FILES
        if name in self.missing:
            raise FileNotFoundError(errno.ENOENT, 'absent')
        return self.allocate(name, 400+self.m.FILES.index(name))

    def close(self, fd):
        assert fd in self.handles, 'double close or foreign FD'
        self.closed.append(fd)
        del self.handles[fd]
        if fd in self.fail_close:
            self.fail_close.remove(fd)
            raise OSError(errno.EIO, 'uncertain close')

    def read(self, fd, count):
        assert count == self.m.MAX_FILE_BYTES+1
        name = self.handles[fd][0]
        return (self.outside if name == 'self' else self.contents[name])[:count]

    def fstat(self, fd):
        name, ino = self.handles[fd]
        return SimpleNamespace(st_dev=5,st_ino=ino,st_mode=(stat.S_IFDIR if name=='directory' else stat.S_IFREG)|0o444)

    def stat(self, name, *, dir_fd, follow_symlinks):
        assert follow_symlinks is False and self.handles[dir_fd][0]=='directory'
        if name in self.missing:
            raise FileNotFoundError(errno.ENOENT,'absent')
        return SimpleNamespace(st_dev=5,st_ino=999 if name in self.replaced else 400+self.m.FILES.index(name),st_mode=stat.S_IFREG|0o444)

    def lseek(self, fd, offset, origin):
        assert fd in self.handles and offset==0 and origin==self.m.os.SEEK_SET
        return 0


def setup():
    m=module(); k=Kernel(m); reader=m.create_event_reader(20)
    return m,k,reader


def test_retains_own_readonly_fds_and_samples_real_bytes_without_claiming_exhaustion():
    m,k,r=setup(); first=r.open(); retained=set(r._files.values())
    assert len(retained)==len(m.FILES) and first['values']['pids.current']==5
    k.contents['pids.events']=b'max 1\n'; k.contents['pids.current']=b'64\n'
    second=r.sample()
    assert retained==set(r._files.values()) and second['values']['pids.events']=={'max':1}
    assert second['files']['pids.events']['rawHex']==b'max 1\n'.hex()
    assert second['sequence']==2 and second['exhaustionValidatedHere'] is False
    assert second['unitCleanupAttestedHere'] is False
    assert r.close() is True and not k.handles


def test_returned_records_cannot_mutate_private_counter_or_inode_binding():
    _,k,r=setup(); first=r.open()
    first['values']['memory.events']['max']=999
    first['files']['memory.events']['identity']['ino']=999
    first['directory']['ino']=999
    assert r.sample()['values']['memory.events']['max']==0
    r.close(); assert not k.handles


@pytest.mark.parametrize('case',['directory-replaced','file-replaced','counter-reset','counter-key-change','missing-required','inside','deadline','limit-change','frozen','empty-procs','oversize','too-many-samples'])
def test_uncertain_or_changed_observation_fences_and_never_synthesizes_zero(case):
    m,k,r=setup()
    k.contents['memory.events']=b'max 2\noom 1\noom_kill 1\n'
    r.open()
    if case=='directory-replaced':k.directory_ino+=1
    if case=='file-replaced':k.replaced.add('memory.events')
    if case=='counter-reset':k.contents['memory.events']=b'max 1\noom 1\noom_kill 1\n'
    if case=='counter-key-change':k.contents['memory.events']=b'max 2\noom 1\noom_kill 1\nother 0\n'
    if case=='missing-required':k.missing.add('memory.events')
    if case=='inside':k.outside=('0::'+r._path.removeprefix('/sys/fs/cgroup')+'/descendant\n').encode()
    if case=='deadline':k.now=20
    if case=='limit-change':k.contents['memory.max']=b'4294967296\n'
    if case=='frozen':k.contents['cgroup.events']=b'populated 1\nfrozen 1\n'
    if case=='empty-procs':k.contents['cgroup.procs']=b''
    if case=='oversize':k.contents['memory.events']=b'x'*4097
    if case=='too-many-samples':r._samples=m.MAX_SAMPLES
    with pytest.raises((ValueError,OSError)):r.sample()
    with pytest.raises(ValueError,match='PREVIOUS_RESOURCE_OBSERVER_UNCERTAIN'):m.create_event_reader(21)
    assert r.close() is False and not k.handles


def test_optional_local_events_absence_is_explicit_not_zero_and_cannot_appear_later():
    m,k,r=setup(); k.missing.add('memory.events.local')
    result=r.open()
    assert result['values']['memory.events.local'] is None
    assert result['files']['memory.events.local']=={'available':False,'errno':2}
    k.missing.clear()
    with pytest.raises(ValueError,match='SUPPORT_CHANGED'):r.sample()
    r.close(); assert not k.handles


def test_close_failure_attempts_all_other_owned_fds_once_and_stays_unknown():
    m,k,r=setup(); r.open(); owned=set(r._files.values())|{r._directory}
    k.fail_close.add(next(iter(r._files.values())))
    with pytest.raises(OSError):r.close()
    assert owned<=set(k.closed) and not k.handles and len(k.closed)==len(set(k.closed))
    assert r.close() is False
    with pytest.raises(ValueError,match='PREVIOUS'):m.create_event_reader(21)


def test_partial_open_failure_closes_all_acquired_handles_and_fences():
    m,k,r=setup(); k.missing.add('pids.events')
    with pytest.raises(FileNotFoundError):r.open()
    assert not k.handles
    with pytest.raises(ValueError,match='PREVIOUS'):m.create_event_reader(21)


@pytest.mark.parametrize('delay',['final-close','report-copy'])
def test_final_seal_includes_path_fd_close_and_report_copy(delay):
    m,k,r=setup();r.open()
    if delay=='final-close':
        original=k.close
        def close(fd):
            fresh=k.handles[fd][0]=='directory' and fd!=r._directory
            original(fd)
            if fresh:k.now=20
        m.os.close=close
    else:
        original=m.copy.deepcopy
        def copy(value):
            result=original(value);k.now=20;return result
        m.copy=SimpleNamespace(deepcopy=copy)
    with pytest.raises(ValueError,match='FINAL_DEADLINE'):r.sample()
    with pytest.raises(ValueError,match='PREVIOUS'):m.create_event_reader(21)
    assert r.close() is False and not k.handles


@pytest.mark.parametrize('value',[True,None,float('nan'),float('inf'),1,182,'20'])
def test_factory_rejects_invalid_deadline_before_any_os_handle(value):
    m=module(); k=Kernel(m)
    with pytest.raises(ValueError):m.create_event_reader(value)
    assert not k.handles


@pytest.mark.parametrize('name,raw',[('pids.max',b'max\n'),('pids.max',b'01\n'),('pids.max',b'-1\n'),
 ('pids.max',b'18446744073709551616\n'),('pids.events',b'max 1\nmax 1\n'),
 ('memory.events',b'max 0\noom 0\n'),('cgroup.procs',b'1\n'),('cgroup.procs',b'2\n2\n')])
def test_metadata_parser_rejects_ambiguous_or_incomplete_counters(name,raw):
    with pytest.raises(ValueError):module().parse_file(name,raw)


def test_walk_close_failure_never_retries_old_fd_and_closes_new_fd():
    m=module(); calls=[]
    def close(fd):
        calls.append(fd)
        if fd==10:raise OSError(errno.EIO,'unknown')
    m.os=SimpleNamespace(O_RDONLY=0,O_DIRECTORY=1,O_NOFOLLOW=2,O_CLOEXEC=4,
        open=lambda path,flags,**kw:10 if path=='/' else 11,close=close)
    with pytest.raises(OSError):m.walk_directory('/sys')
    assert calls==[10,11]
