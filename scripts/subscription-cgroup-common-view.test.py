"""Fake own kernel metadata only. No service, proc reads or cgroup operations."""
import copy
import importlib.util
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('common_view',Path(__file__).with_name('subscription-cgroup-common-view.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
UNIT='codex-cli-resource-'+'a'*32+'.service'
GROUP='/user.slice/user-1000.slice/user@1000.service/app.slice/'

class Kernel(m.Kernel):
    def __init__(self,pid=101,member=GROUP+'observer.scope',now=1):
        self.process=pid;self.member=member;self.clock=now;self.opened={};self.closed=[];self.next=10
        self.mount=b'30 1 0:51 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'
        self.close_error=None;self.drift=False;self.fs=m.CGROUP2
    def now(self):return self.clock
    def uid(self):return 1000
    def pid(self):return self.process
    def namespace(self,kind):return {'pid':'pid:[2]','mnt':'mnt:[3]','cgroup':'cgroup:[4]'}[kind]
    def read(self,name,deadline):
        self.check(deadline)
        raw={'cgroup':('0::'+self.member+'\n').encode(),'mountinfo':self.mount,
             'stat':(str(self.process)+' (fixed helper) '+' '.join(['R']+['0']*18+['100'])+'\n').encode(),
             'status':('Name:\tfixed\nNSpid:\t'+str(self.process)+'\n').encode()}[name]
        return m.raw_record(raw,{'dev':1,'ino':list(m.PROC_LIMITS).index(name)+1,'type':0o100000})
    def walk(self,path,deadline):
        self.check(deadline);self.next+=1;self.opened[self.next]=path;return self.next
    def info(self,fd):
        path=self.opened[fd];ino=int(m.sha(path.encode())[:10],16)
        if self.drift and fd==self.next:ino+=1
        return {'dev':51,'ino':ino,'type':0o40000}
    def filesystem(self,fd):return self.fs
    def close(self,fd):
        self.closed.append(fd)
        if fd==self.close_error:raise OSError('close unknown')

@pytest.fixture(autouse=True)
def reset(monkeypatch):monkeypatch.setattr(m,'_UNKNOWN',False)

def report(pid=101,member=GROUP+'observer.scope',now=1):
    k=Kernel(pid,member,now);view=m.SelfView(now+4,k,m._TOKEN);value=view.sample();assert view.close();value['localHandlesClosed']=True;return value
def complete_reports():
    return report(now=1),report(202,GROUP+UNIT,2),report(now=3),{'unit':UNIT,'uid':1000,'mainPid':202,'mainStartTicks':'100','controlGroup':GROUP+UNIT}

def test_complete_common_visible_view_and_held_identity():
    before,helper,after,binding=complete_reports()
    assert m.validate_common_view(before,helper,after,binding)
    assert m.held_identity(helper)=={**helper['selfIdentity'],'membership':GROUP+UNIT}
    assert len(m.encode(helper))<m.MAX_REPORT_BYTES
    assert not helper['managerNamespaceAttested'] and not helper['hostInitialNamespaceAttested']

@pytest.mark.parametrize('change',['overlay','duplicate-mount','wrong-fs','escaped-path','dotdot','wrong-dev','inode','close','deadline'])
def test_sampler_rejects_overlay_path_fs_identity_and_unknown_close(change):
    k=Kernel();v=m.SelfView(5,k,m._TOKEN)
    if change=='overlay':k.mount+=b'31 30 0:52 / /sys/fs/cgroup/user.slice rw - tmpfs tmpfs rw\n'
    if change=='duplicate-mount':k.mount+=k.mount.replace(b'30 1',b'31 1')
    if change=='wrong-fs':k.fs=0x1234
    if change=='escaped-path':k.member=GROUP+'a\\040b'
    if change=='dotdot':k.member=GROUP+'../other'
    if change=='wrong-dev':k.mount=k.mount.replace(b'0:51',b'0:52')
    if change=='inode':k.drift=True
    if change=='close':k.close_error=12
    if change=='deadline':k.clock=5
    with pytest.raises((ValueError,OSError)):v.sample()
    assert m._UNKNOWN and v.closed and not v.handles
    with pytest.raises(ValueError,match='UNKNOWN'):m.open_self_view(5)

@pytest.mark.parametrize('mutation',['cgroup-ns','parent-identity','mainpid','startticks','unit','uid','early-after','mount-root','false-global','raw-hash','raw-proc-inode','bool-pid','directory-overlay'])
def test_pure_validator_refuses_cross_binding_drift(mutation):
    a,b,c,x=complete_reports()
    if mutation=='cgroup-ns':b['selfIdentity']['cgroupNamespace']='cgroup:[99]'
    if mutation=='parent-identity':c['directories'][m.ROOT]['identity']['ino']+=1
    if mutation=='mainpid':x['mainPid']+=1
    if mutation=='startticks':x['mainStartTicks']='101'
    if mutation=='unit':x['unit']='codex-cli-resource-'+'b'*32+'.service'
    if mutation=='uid':x['uid']=1001
    if mutation=='early-after':c['startedMonotonic']=0
    if mutation=='mount-root':b['mount']['root']='/relative-host'
    if mutation=='false-global':b['globalCapacityAttested']=True
    if mutation=='raw-hash':b['before']['proc']['mountinfo']['sha256']='0'*64
    if mutation=='raw-proc-inode':b['after']['proc']['stat']['identity']['ino']+=1
    if mutation=='bool-pid':x['mainPid']=True
    if mutation=='directory-overlay':b['directories'][m.ancestors(1000)[0]]['filesystemType']=0x1234
    assert not m.validate_common_view(a,b,c,x)

def test_retained_view_samples_same_handles_and_closes_once():
    k=Kernel();v=m.SelfView(5,k,m._TOKEN);one=v.sample();retained=dict(v.handles);k.clock=2;two=v.sample()
    assert retained==v.handles and one['sequence']==1 and two['sequence']==2 and m.validate_self_report(two)
    assert v.close();closed=list(k.closed);assert v.close() and k.closed==closed
    assert all(fd in closed for fd in retained.values())

def test_close_unknown_attempts_every_retained_handle():
    k=Kernel();v=m.SelfView(5,k,m._TOKEN);v.sample();fds=list(v.handles.values());k.close_error=fds[0]
    assert not v.close() and m._UNKNOWN and all(fd in k.closed for fd in fds)

def test_final_deadline_after_readonly_sampling_cannot_pass(monkeypatch):
    k=Kernel();v=m.SelfView(5,k,m._TOKEN);old=m.encode
    def delayed(value):k.clock=5;return old(value)
    monkeypatch.setattr(m,'encode',delayed)
    with pytest.raises(ValueError):v.sample()
    assert m._UNKNOWN and v.closed

@pytest.mark.parametrize('raw',[b'0::/a/../b\n',b'0::/a//b\n',b'0::/a\\012b\n',b'0::/a\n1::/b\n'])
def test_membership_no_escaped_or_ambiguous_paths(raw):
    with pytest.raises(ValueError):m.membership(raw)

def test_namespaced_mount_root_is_not_host_initial_attestation():
    k=Kernel();k.mount=k.mount.replace(b'0:51 / ',b'0:51 /visible-subtree ')
    v=m.SelfView(5,k,m._TOKEN);r=v.sample();assert v.close()
    assert m.validate_self_report(r) and r['mount']['root']=='/visible-subtree' and not r['hostInitialNamespaceAttested']

@pytest.mark.parametrize('case',['other-pid-ns','nested-nspid'])
def test_valid_self_reports_require_narrow_common_pid_view(case):
    a,b,c,x=complete_reports()
    for edge in ('before','after'):
        if case=='other-pid-ns':b[edge]['namespaces']['pid']='pid:[99]'
        else:
            raw=b'Name:\tfixed\nNSpid:\t999 202\n';b[edge]['proc']['status']=m.raw_record(raw,b[edge]['proc']['status']['identity'])
    b['selfIdentity']=m.validate_snapshot(b['before'])['identity']
    if case=='nested-nspid':x['mainPid']=999
    assert m.validate_self_report(b) is (case=='other-pid-ns')
    assert not m.validate_common_view(a,b,c,x)

def test_convenience_final_close_failure_is_sticky(monkeypatch):
    k=Kernel();k.close_error=11
    view=m.SelfView(5,k,m._TOKEN);monkeypatch.setattr(m,'open_self_view',lambda _:view)
    with pytest.raises(ValueError):m.sample_self(5)
    assert m._UNKNOWN and view.closed

@pytest.mark.parametrize('fault',['open','intermediate-close','post-close-deadline'])
def test_real_walk_attempts_all_owned_fds_on_setup_or_late_failure(monkeypatch,fault):
    k=m.Kernel();opened=[];closed=[];now=[1]
    for name in ('O_DIRECTORY','O_NOFOLLOW','O_CLOEXEC'):monkeypatch.setattr(m.os,name,0,raising=False)
    def opening(*a,**kw):
        if fault=='open' and len(opened)==2:raise OSError('fixed open failed')
        fd=10+len(opened);opened.append(fd);return fd
    def close(fd):
        closed.append(fd)
        if fault=='intermediate-close' and fd==11:raise OSError('unknown intermediate close')
        if fault=='post-close-deadline' and fd==10:now[0]=5
    monkeypatch.setattr(m.os,'open',opening);monkeypatch.setattr(k,'close',close);monkeypatch.setattr(k,'now',lambda:now[0])
    with pytest.raises((ValueError,OSError)):k.walk(m.ROOT,5)
    assert sorted(closed)==sorted(opened) and len(closed)==len(set(closed))
    assert m._UNKNOWN is (fault=='intermediate-close')
