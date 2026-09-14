"""Owned Python threads and fixed mock service peers; no units/process/network."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import threading
import time
import pytest


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=load('subscription-cgroup-common-view-preflight.py')
sf=load('subscription-cgroup-common-view-service.test.py')
ef=load('subscription-candidate-resource-events.test.py')


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(m,'_FENCED',False);monkeypatch.setattr(m,'_ACTIVE',None)


def setup(monkeypatch,service_call=None,large=False):
    report,_,pure=sf.complete_report();service=load(m.SERVICE_FILES[0]);sampler=pure[0]
    codec=load('subscription-cgroup-evidence-stream.py');events=ef.module()
    events.os=SimpleNamespace(getuid=lambda:1000);events.uuid=SimpleNamespace(uuid4=lambda:SimpleNamespace(hex='b'*32))
    reader=events.create_event_reader(time.monotonic()+35)
    expected={name:m.hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in m.SERVICE_FILES}
    report['sourceSha256']=dict(expected);report['sourceSha256After']=dict(expected)
    report['helper']['sourceSha256']={name:expected[name] for name in m.SERVICE_FILES[1:3]}
    if large:
        # Authored bounded status metadata, still passed through the actual
        # sampler/service parsers. This is not a claimed kernel observation.
        for snapshot in (report['observerBefore'],report['observerAfter'],report['helper']['observation']):
            for edge in ('before','after'):
                record=snapshot[edge]['proc']['status'];raw=bytes.fromhex(record['rawHex'])+b'FixturePadding:\t'+b'0'*12000+b'\n'
                record.update(rawHex=raw.hex(),bytes=len(raw),sha256=m.hashlib.sha256(raw).hexdigest())
    report['rawStdoutHex']=(service.encode(report['helper'])+b'\n').hex()
    assert service.validate_report(report,expected,(sampler,))
    deps=(service,sampler,codec,events)
    for name,module in zip(m.DEPENDENCY_FILES,deps):
        module.__source_sha256__=m.hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
    monkeypatch.setattr(service,'run',service_call or (lambda *_a,**_k:copy.deepcopy(report)))
    controller=m.create_preflight(reader,expected,time.monotonic()+34,deps)
    return controller,report,reader,expected,deps


def drain(controller,limit=3):
    frames=[];deadline=time.monotonic()+limit
    while time.monotonic()<deadline:
        value=controller.poll()
        if value is not None:frames.append(value)
        if controller.finished() and controller._queue_bytes==0:break
        time.sleep(.001)
    assert controller.finished()
    return frames


def test_real_codec_drains_actual_service_fixture_before_result(monkeypatch):
    controller,expected,*_=setup(monkeypatch);decoder=controller.codec.Decoder(controller.unit)
    assert controller.result() is None
    controller.start();frames=drain(controller);completed=[]
    for frame in frames:
        item=decoder.feed(frame)
        if item is not None:completed.append(item)
    assert len(completed)==1 and completed[0]['label']=='service'
    assert controller.service.strict(completed[0]['raw'])==expected
    result=controller.result();assert result==expected
    result['errors'].append('caller mutation');assert controller.result()==expected
    summary=controller.terminal();assert summary['queueDocumentDrained'] and summary['workerFinished']
    assert 'helper' not in summary and summary['maxQueueBytes']<=m.QUEUE_BYTES
    assert controller.close() is True and not m._FENCED


def test_nonblocking_poll_keeps_caller_pumping_while_service_waits(monkeypatch):
    entered=threading.Event();release=threading.Event();body=[None]
    def service(*_a,**_k):entered.set();assert release.wait(2);return body[0]
    controller,report,*_=setup(monkeypatch,service);body[0]=report
    controller.start();assert entered.wait(1)
    try:
        before=time.monotonic()
        assert all(controller.poll() is None for _ in range(100))
        assert time.monotonic()-before<.2 and controller.result() is None
    finally:release.set()
    drain(controller);assert controller.close()


def test_backpressure_at_four_frames_cancel_wakes_producer(monkeypatch):
    controller,report,*_=setup(monkeypatch,large=True)
    # Authored full report validates before the real codec sees it.
    controller.start();deadline=time.monotonic()+2
    while len(controller._queue)<4 and time.monotonic()<deadline:time.sleep(.001)
    assert len(controller._queue)==4 and controller._queue_bytes<=m.QUEUE_BYTES
    assert controller.result() is None
    controller.cancel();assert controller.poll() is None
    drain(controller);assert controller.result() is None and m._FENCED
    assert controller.close() is True


def test_cancel_returned_success_before_queue_suppresses_result(monkeypatch):
    holder={};body=[None]
    def service(*_a,**_k):holder['c'].cancel();return body[0]
    controller,report,*_=setup(monkeypatch,service);holder['c']=controller;body[0]=report
    controller.start();assert drain(controller)==[]
    assert controller.result() is None and m._FENCED
    assert controller.close() is False  # no accepted service cleanup snapshot


def test_cancel_after_all_delivery_still_suppresses_result(monkeypatch):
    controller,*_=setup(monkeypatch);controller.start();assert drain(controller)
    controller.cancel();assert controller.result() is None and controller.poll() is None and m._FENCED
    assert controller.close() is True


@pytest.mark.parametrize('case',['foreign-reader','source','path','parallel'])
def test_fixed_factory_does_not_accept_foreign_identity_or_concurrent_service(monkeypatch,case):
    c,report,reader,expected,deps=setup(monkeypatch)
    if case!='parallel':assert c.close()
    if case=='foreign-reader':reader=SimpleNamespace()
    elif case=='source':expected[m.SERVICE_FILES[0]]='0'*64
    elif case=='path':reader._path='/foreign'
    with pytest.raises(ValueError):m.create_preflight(reader,expected,time.monotonic()+30,deps)


def test_join_exception_is_sticky_unknown_and_does_not_reap_foreign_process(monkeypatch):
    c,*_=setup(monkeypatch);c._started=True;c._thread=Mock()
    c._thread.is_alive.return_value=True;c._thread.join.side_effect=RuntimeError('join')
    assert c.close() is False and c.close() is False and m._FENCED
    assert m._ACTIVE is c


def test_thread_start_failure_retains_unknown_ownership(monkeypatch):
    c,*_=setup(monkeypatch);thread=Mock();thread.start.side_effect=RuntimeError('start');thread.is_alive.return_value=False
    monkeypatch.setattr(m.threading,'Thread',lambda **_:thread)
    with pytest.raises(RuntimeError):c.start()
    assert c.close() is False and m._FENCED


def test_queue_frame_bound_and_stale_result_never_pass(monkeypatch):
    c,*_=setup(monkeypatch)
    with pytest.raises(ValueError,match='FRAME_BOUND'):c._put(b'x'*(m.FRAME_LIMIT+1))
    c.start();drain(c);c.deadline=time.monotonic()-1
    assert c.result() is None and m._FENCED and c.close() is False


def test_cancel_during_pure_validation_never_enqueues_success(monkeypatch):
    c,*_=setup(monkeypatch);original=c.service.validate_report
    def validate(*args):
        result=original(*args);c.cancel();return result
    monkeypatch.setattr(c.service,'validate_report',validate)
    c.start();assert drain(c)==[] and c.result() is None and m._FENCED
    assert c.close() is True


def test_poll_contended_queue_never_waits(monkeypatch):
    c,*_=setup(monkeypatch);entered=threading.Event();release=threading.Event()
    def hold():
        with c._condition:entered.set();assert release.wait(2)
    thread=threading.Thread(target=hold);thread.start();assert entered.wait(1)
    try:
        began=time.monotonic();assert c.poll() is None;assert time.monotonic()-began<.1
    finally:release.set();thread.join(1)
    assert not thread.is_alive() and c.close()


def test_deadline_on_blocked_producer_cancels_without_more_delivery(monkeypatch):
    c,*_=setup(monkeypatch,large=True);c.start();end=time.monotonic()+2
    while len(c._queue)<4 and time.monotonic()<end:time.sleep(.001)
    assert len(c._queue)==4;c.deadline=time.monotonic()-1
    assert c.poll() is None;drain(c)
    assert c.result() is None and m._FENCED and c.close() is False
