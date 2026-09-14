"""Fixed cgroup probe composition; source-bound trusted-control parent reuse."""
import hashlib
import json
import math
import os
import re
import stat
import sys
import time
import types

GATE_ARGV=('/usr/bin/python3','-I','-S','/usr/bin/exec-server-worker-gate.py','--trusted-cgroup-worker-boundary')
PROBE_ARGV=['/usr/bin/python3','-I','-S','/usr/bin/trusted-cgroup-worker-probe.py']
HELPERS={
 'subscription-exec-server-worker-gate.py':'/usr/bin/exec-server-worker-gate.py',
 'subscription-exec-server-worker-trampoline.py':'/usr/bin/exec-server-worker-trampoline.py',
 'subscription-exec-worker-probe.py':'/usr/bin/exec-worker-probe.py',
 'subscription-trusted-control-boundary-probe.py':'/usr/bin/trusted-control-boundary-probe.py',
 'subscription-worker-lockdown.py':'/usr/bin/worker-lockdown.py',
 'subscription-appserver-noenv.py':'/usr/bin/appserver-noenv.py',
 'subscription-text-model-catalog.json':'/usr/bin/text-model-catalog.json',
 'subscription-trusted-control-boundary-parent.py':'/usr/bin/trusted-control-boundary-parent.py',
 'subscription-trusted-cgroup-worker-probe.py':'/usr/bin/trusted-cgroup-worker-probe.py',
 'subscription-trusted-cgroup-worker-child.py':'/usr/bin/trusted-cgroup-worker-child.py'}
CATALOG_SHA256='59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'


def same(a,b):return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)


def fixed_bytes(name):
    fd=os.open(HELPERS[name],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:
        first=os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or not 0<first.st_size<=1024*1024 or not os.fstatvfs(fd).f_flag&os.ST_RDONLY:raise ValueError('READONLY_HELPER_REQUIRED')
        raw=os.read(fd,1024*1024+1);last=os.fstat(fd)
        if len(raw)!=first.st_size or (first.st_dev,first.st_ino,first.st_mtime_ns)!=(last.st_dev,last.st_ino,last.st_mtime_ns):raise ValueError('HELPER_CHANGED')
        return raw
    finally:os.close(fd)


def hashes():
    result={name:hashlib.sha256(fixed_bytes(name)).hexdigest() for name in HELPERS}
    if result['subscription-text-model-catalog.json']!=CATALOG_SHA256:raise ValueError('CATALOG_HASH')
    return result


def load_fixed(name):
    value=types.ModuleType('private_cgroup_child_'+name.replace('-','_'));value.__file__=HELPERS[name]
    exec(compile(fixed_bytes(name),value.__file__,'exec'),value.__dict__);return value


def compose(parent,gate,base,cgroup,base_hash):
    """All passed modules are private exact-source instances owned by this caller."""
    constructor=getattr(gate,'cgroup_start_request',None)
    if not callable(constructor):raise ValueError('CGROUP_GATE_NOT_INTEGRATED')
    expected=gate.control_start_request();expected['params']['argv']=list(PROBE_ARGV)
    if not same(constructor(),expected):raise ValueError('FIXED_CGROUP_ENTRY_REQUIRED')
    gate_view=types.SimpleNamespace(**vars(gate));gate_view.control_start_request=constructor
    probe_view=types.SimpleNamespace(**vars(base))
    probe_view.validate_report=lambda report,marker:cgroup.validate_report_with(base,report,marker,base_hash)
    if not hasattr(parent,'_cgroup_original_worker'):
        parent._cgroup_original_worker=parent.WorkerProtocol
    original=parent._cgroup_original_worker
    captured=[]
    def required(view):
        if not same(view.control_start_request(),expected):raise ValueError('FIXED_CGROUP_ENTRY_REQUIRED')
        return GATE_ARGV
    class Worker(original):
        def receive(self,frame):
            try:super().receive(frame)
            finally:
                if self.worker_report is not None and not getattr(self,'_captured_body',False):
                    # Preserve rejected actual bodies too; no validation credit.
                    captured.append(json.loads(json.dumps(self.worker_report,allow_nan=False)))
                    self._captured_body=True
            if self.done and self.worker_report is not None and 'marker' not in self.worker_report:
                # Alias is internal only, after complete new-probe validation.
                self.worker_report['marker']=self.worker_report['baseReport']['marker']
    parent.require_fixed_worker_entry=required
    parent.GATE_ARGV=GATE_ARGV
    parent.WorkerProtocol=Worker
    return gate_view,probe_view,captured


def validate_report(report,deps,expected_worker_boundary):
    try:
        parent,policy,gate,base,cgroup=deps
        if type(report) is not dict or set(report)!={'version','profile','success','error','parentReport','cgroupReport','helperSha256Before','helperSha256After','elapsedMs'}:return False
        if type(report['version']) is not int or report['version']!=1 or report['profile']!='fixed-trusted-cgroup-worker-child' or report['success'] is not True or report['error'] is not None:return False
        h=report['helperSha256Before']
        if type(h) is not dict or set(h)!=set(HELPERS) or not same(h,report['helperSha256After']) or any(type(x) is not str or re.fullmatch('[a-f0-9]{64}',x) is None for x in h.values()) or h['subscription-text-model-catalog.json']!=CATALOG_SHA256:return False
        elapsed=report['elapsedMs']
        if type(elapsed) not in (int,float) or not math.isfinite(elapsed) or not 0<=elapsed<parent.TOTAL_SECONDS*1000:return False
        pr=report['parentReport']
        view,probe,captured=compose(parent,gate,base,cgroup,h['subscription-trusted-control-boundary-probe.py'])
        if not parent.validate_report(pr,policy,view,probe,expected_worker_boundary):return False
        if pr['elapsedMs']>elapsed or not same(pr['helperSha256Before'],{name:h[name] for name in parent.HELPER_FILES}):return False
        return len(captured)==1 and same(captured[0],report['cgroupReport']) and cgroup.validate_report_with(base,report['cgroupReport'],pr['marker']['value'],h['subscription-trusted-control-boundary-probe.py'])
    except (ValueError,TypeError,KeyError,AttributeError,IndexError):return False


def seal_report(report,deps,budget,expected):
    report['helperSha256After']=hashes()
    report['elapsedMs']=(time.monotonic()-budget.began)*1000
    valid=validate_report(report,deps,expected)
    report['elapsedMs']=(time.monotonic()-budget.began)*1000
    if not 0<=report['elapsedMs']<deps[0].TOTAL_SECONDS*1000:
        report['success']=False;report['error']=report['error'] or 'CGROUP_CHILD_TOTAL_DEADLINE'
    elif not valid:
        report['success']=False;report['error']=report['error'] or 'CGROUP_CHILD_REPORT_INVALID'
    return report


def main():
    if sys.platform!='linux' or sys.argv[1:]:raise ValueError('FIXED_CAPSULE_ENTRY_REQUIRED')
    began=time.monotonic();before=hashes()
    names=('subscription-trusted-control-boundary-parent.py','subscription-appserver-noenv.py','subscription-exec-server-worker-gate.py','subscription-trusted-control-boundary-probe.py','subscription-trusted-cgroup-worker-probe.py')
    deps=tuple(load_fixed(name) for name in names)
    parent,policy,gate,base,cgroup=deps
    budget=parent.Budget();budget.began=began
    view,probe,captured=compose(parent,gate,base,cgroup,before['subscription-trusted-control-boundary-probe.py'])
    packet=parent.read_startup_packet(budget,base)
    pr=parent.run_parent(policy,view,probe,budget,packet)
    pr['helperSha256Before']={name:before[name] for name in parent.HELPER_FILES}
    pr['helperSha256After']=parent.helper_hashes()
    pr['elapsedMs']=(time.monotonic()-began)*1000
    pr['success']=pr['error'] is None
    report={'version':1,'profile':'fixed-trusted-cgroup-worker-child','success':pr['success'],'error':pr['error'],
            'parentReport':pr,'cgroupReport':captured[0] if len(captured)==1 else None,'helperSha256Before':before,'helperSha256After':None,'elapsedMs':None}
    expected={'namespace':packet['value']['namespaces']['trustedPid'],'mountNamespace':packet['value']['namespaces']['trustedMount'],
              'control':packet['value']['protectedDescriptors']['outerSupervisorControl'],'output':packet['value']['protectedDescriptors']['outerSupervisorOutput']}
    seal_report(report,deps,budget,expected)
    print(json.dumps(report,separators=(',',':'),allow_nan=False),flush=True)
    return 0 if report['success'] else 1


if __name__=='__main__':raise SystemExit(main())
