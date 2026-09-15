"""One owned pretarget metadata service worker and bounded evidence queue."""
from collections import deque
import copy
import hashlib
import math
import re
import threading
import time

SERVICE_FILES=('subscription-cgroup-common-view-service.py','subscription-cgroup-common-view.py',
    'subscription-cgroup-common-view-child.py','subscription-systemd-fixture-transport.py','subscription-systemd-cli-probe.py')
DEPENDENCY_FILES=(SERVICE_FILES[0],SERVICE_FILES[1],'subscription-cgroup-evidence-stream.py','subscription-candidate-resource-events.py')
QUEUE_FRAMES=4
QUEUE_BYTES=262144
FRAME_LIMIT=45000
DOCUMENT_LIMIT=2*1024*1024
_TOKEN=object()
_ACTIVE=None
_FENCED=False


def require(value,reason):
    if not value:raise ValueError(reason)
def valid_hash(value):return type(value) is str and re.fullmatch('[a-f0-9]{64}',value) is not None
def error_label(error):
    text=str(error)
    return type(error).__name__+(':'+text if type(error) is ValueError and re.fullmatch('[A-Z_]{1,128}',text) else '')


def create_preflight(reader,expected_service_hashes,absolute_deadline,deps):
    global _ACTIVE
    require(not _FENCED,'PRIOR_COMMON_PREFLIGHT_UNKNOWN')
    require(_ACTIVE is None,'COMMON_PREFLIGHT_ALREADY_OWNED')
    require(type(deps) is tuple and len(deps)==4,'COMMON_PREFLIGHT_DEPENDENCIES')
    service,sampler,codec,events=deps
    require(type(expected_service_hashes) is dict and set(expected_service_hashes)==set(SERVICE_FILES)
        and all(valid_hash(v) for v in expected_service_hashes.values()),'COMMON_PREFLIGHT_SOURCE_KEYS')
    hashes={name:getattr(module,'__source_sha256__',None) for name,module in zip(DEPENDENCY_FILES,deps)}
    require(all(valid_hash(v) for v in hashes.values()) and all(hashes[n]==expected_service_hashes[n] for n in SERVICE_FILES[:2]),
        'COMMON_PREFLIGHT_DEPENDENCY_HASH')
    require(tuple(service.FILES)==SERVICE_FILES,'COMMON_PREFLIGHT_FIXED_SERVICE')
    require(type(reader) is events.EventReader and reader._closed is False and reader._failed is False,
        'COMMON_PREFLIGHT_FACTORY_READER')
    unit=reader.unit;uid=events.os.getuid()
    require(type(uid) is int and uid>=0 and type(unit) is str and re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',unit),
        'COMMON_PREFLIGHT_TARGET_IDENTITY')
    expected='/sys/fs/cgroup/user.slice/user-'+str(uid)+'.slice/user@'+str(uid)+'.service/app.slice/'+unit
    require(reader._path==expected,'COMMON_PREFLIGHT_FACTORY_PATH')
    now=time.monotonic()
    require(type(absolute_deadline) in (int,float) and math.isfinite(absolute_deadline)
        and 0<absolute_deadline-now<=35,'COMMON_PREFLIGHT_DEADLINE')
    result=Preflight(unit,copy.deepcopy(expected_service_hashes),hashes,min(absolute_deadline,reader.deadline),deps,_TOKEN)
    _ACTIVE=result
    return result


class Preflight:
    def __init__(self,unit,hashes,dependency_hashes,deadline,deps,token):
        require(token is _TOKEN,'COMMON_PREFLIGHT_FACTORY_REQUIRED')
        self.unit=unit;self.hashes=hashes;self.dependency_hashes=dependency_hashes;self.deadline=deadline
        self.service,self.sampler,self.codec,self.events=deps
        self._condition=threading.Condition();self._queue=deque();self._queue_bytes=0
        self._cancel=threading.Event();self._finished=threading.Event();self._thread=None
        self._started=False;self._closed=False;self._close_known=None;self._error=None;self._raw=None
        self._producer_complete=False;self._validated=False;self._local_known=False
        self._enqueued=0;self._delivered=0;self._wire_bytes=0;self._max_queue_bytes=0

    def _check(self):
        require(not self._cancel.is_set(),'COMMON_PREFLIGHT_CANCELLED')
        require(time.monotonic()<self.deadline,'COMMON_PREFLIGHT_DEADLINE')

    def _fail(self,reason):
        global _FENCED
        _FENCED=True;self._cancel.set()
        with self._condition:
            self._error=self._error or reason
            self._queue.clear();self._queue_bytes=0;self._condition.notify_all()

    def _put(self,frame):
        require(type(frame) is bytes and 0<len(frame)<=FRAME_LIMIT,'COMMON_PREFLIGHT_FRAME_BOUND')
        with self._condition:
            while len(self._queue)>=QUEUE_FRAMES or self._queue_bytes+len(frame)>QUEUE_BYTES:
                self._check();self._condition.wait(min(.05,max(0,self.deadline-time.monotonic())))
            self._check();self._queue.append(frame);self._queue_bytes+=len(frame);self._enqueued+=1
            self._max_queue_bytes=max(self._max_queue_bytes,self._queue_bytes)
            self._condition.notify_all()

    def _work(self):
        try:
            self._check()
            result=self.service.run(copy.deepcopy(self.hashes),_deadline=min(self.deadline,time.monotonic()+30),_cancel_event=self._cancel)
            self._check()
            require(type(result) is dict and result.get('unit')!=self.unit,'COMMON_PREFLIGHT_SERVICE_UNIT')
            raw=self.service.encode(result)
            require(type(raw) is bytes and 0<len(raw)<=DOCUMENT_LIMIT,'COMMON_PREFLIGHT_DOCUMENT_BOUND')
            # Retain one bounded canonical document, not a terminal duplicate.
            self._raw=raw
            self._local_known=type(result.get('cleanup')) is dict and result['cleanup'].get('localHandlesClosed') is True
            require(result.get('commonViewValidated') is True and self.service.validate_report(result,self.hashes,(self.sampler,)) is True,
                    'COMMON_PREFLIGHT_SERVICE_REJECTED')
            self._check();self._validated=True
            for frame in self.codec.encode_document(self.unit,'service',raw):
                self._check();self._put(frame)
            self._check();self._producer_complete=True
        except BaseException as error:self._fail(error_label(error))
        finally:self._finished.set()

    def start(self):
        require(not self._started and not self._closed,'COMMON_PREFLIGHT_SINGLE_START')
        self._check();self._started=True
        try:
            self._thread=threading.Thread(target=self._work,daemon=True)
            self._thread.start()
        except BaseException as error:
            self._fail('COMMON_PREFLIGHT_START_FAILED:'+type(error).__name__)
            # Keep any created Thread object. Its state/ownership is settled by
            # close, never inferred solely from the start exception.
            raise

    def poll(self):
        if self._closed or self._cancel.is_set():return None
        if time.monotonic()>=self.deadline:
            self._fail('COMMON_PREFLIGHT_DEADLINE');return None
        # No join and no wait for a producer lock in the caller's pump.
        if not self._condition.acquire(blocking=False):return None
        try:
            if self._cancel.is_set() or not self._queue:return None
            frame=self._queue.popleft();self._queue_bytes-=len(frame)
            self._condition.notify_all()
            if self._cancel.is_set():return None
            self._delivered+=1;self._wire_bytes+=len(frame)
            return frame
        finally:self._condition.release()

    def cancel(self):self._fail('COMMON_PREFLIGHT_CANCELLED')

    def finished(self):
        if self._thread is None:return not self._started
        try:return self._finished.is_set() and not self._thread.is_alive()
        except BaseException:
            self._fail('COMMON_PREFLIGHT_THREAD_STATE_UNKNOWN');return False

    def result(self):
        if self._cancel.is_set() or self._closed:return None
        if time.monotonic()>=self.deadline:
            self._fail('COMMON_PREFLIGHT_DEADLINE');return None
        if not self.finished():return None
        with self._condition:
            if self._queue or not self._producer_complete or not self._validated or not self._local_known:return None
        result=self.service.strict(self._raw)
        if self._cancel.is_set():return None
        if time.monotonic()>=self.deadline:
            self._fail('COMMON_PREFLIGHT_DEADLINE');return None
        return result

    def close(self):
        global _ACTIVE,_FENCED
        if self._closed:return self._close_known
        self._closed=True;known=True
        if self._thread is not None:
            try:
                if self._thread.is_alive():
                    self._cancel.set()
                    with self._condition:self._condition.notify_all()
                    self._thread.join(min(1,max(0,self.deadline-time.monotonic())))
                known=not self._thread.is_alive()
            except BaseException:known=False
        if self._started and not self._finished.is_set():known=False
        if self._started and not self._local_known:known=False
        if time.monotonic()>=self.deadline:known=False
        self._close_known=known
        if not known:_FENCED=True
        if known and _ACTIVE is self:_ACTIVE=None
        with self._condition:self._queue.clear();self._queue_bytes=0;self._condition.notify_all()
        return known

    def terminal(self):
        # Bounded summary only. No service body, auth data or opaque payload.
        return {'version':1,'type':'common_view_preflight','targetUnit':self.unit,'sourceSha256':dict(self.hashes),
            'dependencySha256':dict(self.dependency_hashes),'documentSha256':hashlib.sha256(self._raw).hexdigest() if self._raw is not None else None,
            'documentBytes':len(self._raw) if self._raw is not None else 0,'framesEnqueued':self._enqueued,'framesPolled':self._delivered,
            'wireBytesPolled':self._wire_bytes,'maxQueueBytes':self._max_queue_bytes,'workerFinished':self.finished(),
            'queueDocumentDrained':self._producer_complete and self._delivered==self._enqueued and not self._cancel.is_set(),
            'localHandlesKnown':self._local_known,'closeKnown':self._close_known,'cancelled':self._cancel.is_set(),
            'error':self._error,'releaseAdmitted':False,'productionReady':False}


if __name__=='__main__':raise SystemExit('TRUSTED_PRETARGET_OWNER_REQUIRED')
