"""Authored metadata and syscall mocks; no service/unit/network execution."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import pytest


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('subscription-cgroup-common-view-service.py')
fixtures=load('subscription-cgroup-common-view.test.py')


def complete_report():
    before,helper,after,b=fixtures.complete_reports();hashes={name:'a'*64 for name in m.FILES}
    manager={'managerIdentityProfile':'private-socket-peer-v1','managerPid':99,'managerUid':1000,'managerGid':1000,
             'managerStartTimeTicks':'10','managerSocket':{'path':'/run/user/1000/systemd/private',
             'components':[{'dev':1,'ino':i+1,'mode':0xc180 if i==4 else 0x41ed,'uid':1000,'gid':1000} for i in range(5)]},
             'managerCgroup':'/user.slice/user-1000.slice/user@1000.service/init.scope'}
    binding={**manager,'driverPid':101,'driverCgroup':before['membership'],'unitMainPid':202,
             'unitMainStartTimeTicks':'100','unitMainCgroup':b['controlGroup']}
    raw=('202 (fixed) '+' '.join(['S','99']+['0']*17+['100'])+'\n').encode()
    main={'pid':202,'startTicks':'100','state':'S','rawStatHex':raw.hex(),'rawStatSha256':m.hashlib.sha256(raw).hexdigest()}
    envelope={'version':1,'type':'common_view_sample','sourceSha256':{name:hashes[name] for name in m.FILES[1:3]},
              'observation':helper,'productionReady':False,'modelCalls':0}
    value={'version':1,'type':'common_view_service','unit':b['unit'],'command':m.command(b['unit']),
           'sourceSha256':hashes,'sourceSha256After':dict(hashes),'commonViewValidated':True,'productionReady':False,'modelCalls':0,
           'errors':[],'cleanup':{'unitAbsent':True,'leafAbsent':True,'systemdRunClosed':True,'localHandlesClosed':True,'errors':[],'notSpawned':False,
                'helperPinOutcome':{'exitReady':True,'pollFlags':1,'signalZeroErrno':3}},
           'streamEOF':{'stdout':True,'stderr':True},'exitCode':0,'rawStdoutHex':(m.encode(envelope)+b'\n').hex(),'rawStderrHex':'',
           'helper':envelope,'manager':manager,'bindingBefore':binding,'bindingAfter':copy.deepcopy(binding),
           'mainBefore':main,'mainAfter':copy.deepcopy(main),'expectedBinding':b,'observerBefore':before,'observerAfter':after,
           'readbackBefore':{'memoryMax':'2147483648','memorySwapMax':'0','pidsMax':'64'},
           'readbackAfter':{'memoryMax':'2147483648','memorySwapMax':'0','pidsMax':'64'}}
    return value,hashes,(fixtures.m,)


def test_full_report_replays_actual_sampler_without_io():
    value,hashes,deps=complete_report()
    with patch.object(m.os,'open',side_effect=AssertionError('NO_IO')),patch.object(m.subprocess,'Popen',side_effect=AssertionError('NO_RUNTIME')):
        assert m.validate_report(value,hashes,deps)


@pytest.mark.parametrize('case',['source','helper-source','unit','manager','generation','zombie','ppid','view','before-order','eof','stderr','cleanup','exit','readback','raw','helper-credit'])
def test_full_replay_rejects_incomplete_or_changed_evidence(case):
    value,hashes,deps=complete_report()
    if case=='source':value['sourceSha256After']={}
    elif case=='helper-source':value['helper']['sourceSha256']={}
    elif case=='unit':value['unit']='foreign'
    elif case=='manager':value['bindingAfter']['managerPid']=98
    elif case=='generation':value['mainAfter']['startTicks']='101'
    elif case=='zombie':value['mainAfter']['state']='Z'
    elif case=='ppid':value['manager']['managerPid']=98
    elif case=='view':value['observerAfter']['directories']['/sys/fs/cgroup']['identity']['ino']+=1
    elif case=='before-order':value['observerBefore']['sealedMonotonic']=4
    elif case=='eof':value['streamEOF']['stdout']=False
    elif case=='stderr':value['rawStderrHex']='61'
    elif case=='cleanup':value['cleanup']['localHandlesClosed']=False
    elif case=='exit':value['exitCode']=True
    elif case=='readback':value['readbackAfter']['pidsMax']='65'
    elif case=='raw':value['rawStdoutHex']='00'
    elif case=='helper-credit':value['helper']['productionReady']=True
    assert not m.validate_report(value,hashes,deps)


@pytest.mark.parametrize('raw',[b'{"a":1,"a":2}',b'{"a":NaN}'])
def test_strict_json_refuses_duplicate_nonfinite(raw):
    with pytest.raises(ValueError):m.strict(raw)


def test_fixed_command_has_no_workload_or_caller_overrides():
    argv=m.command(fixtures.UNIT)
    assert argv==['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--collect',
        '--unit=codex-cli-resource-'+'a'*32+'.service',
        '--property=MemoryMax=2147483648','--property=MemorySwapMax=0','--property=TasksMax=64',
        '--property=RuntimeMaxSec=20','--property=TimeoutStopSec=5','--property=KillMode=control-group',
        '--property=WorkingDirectory=/','/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C',
        '/usr/bin/python3','-I','-S','/mnt/d/claude/Hackaton/scripts/subscription-cgroup-common-view-child.py']
    assert '--property=RuntimeMaxSec=20' in argv and '--property=TimeoutStopSec=5' in argv
    with pytest.raises(ValueError):m.command('foreign.service')


def test_full_replay_rejects_backslash_command_path():
    value,hashes,deps=complete_report()
    value['command'][-1]=r'\mnt\d\claude\Hackaton\scripts\subscription-cgroup-common-view-child.py'
    assert m.validate_report(value,hashes,deps) is False


def test_pidfd_readiness_refuses_before_signal():
    poll=Mock();poll.poll.return_value=[(7,1)]
    with patch.object(m.select,'poll',return_value=poll,create=True),patch.object(m.select,'POLLIN',1,create=True),patch.object(m.signal,'pidfd_send_signal',create=True) as send:
        with pytest.raises(ValueError,match='PIN_EXITED'):m.live(7)
        send.assert_not_called()


def test_cleanup_failure_attempts_all_owned_handles_and_keeps_unknown():
    process=Mock(returncode=0);capture=Mock();capture.close.side_effect=OSError('close')
    view=Mock();view.close.return_value=False
    relay=Mock();relay.unit_absent.return_value=True
    probe=Mock();probe.leaf_path.return_value='/fixed-own-leaf'
    with patch.object(m.os,'close',side_effect=[OSError('first'),None]) as close,patch.object(m.os,'lstat',side_effect=FileNotFoundError):
        result=m.cleanup(process,False,fixtures.UNIT,relay,probe,capture,view,[4,5],m.time.monotonic()+5)
    assert result['localHandlesClosed'] is False and len(result['errors'])>=3
    assert [v.args[0] for v in close.call_args_list]==[4,5]
    process.stdout.close.assert_called_once();process.stderr.close.assert_called_once()


def test_after_popen_selector_failure_still_stops_own_unit_and_fences(monkeypatch):
    hashes={name:'a'*64 for name in m.FILES};probe=Mock();relay=Mock();sampler=Mock();child=Mock()
    relay.unit_absent.side_effect=[True,False,True];relay.manager_connection.return_value={'managerPid':99,'managerStartTimeTicks':'10'}
    relay.process_start_ticks.return_value='10'
    process=Mock(returncode=0)
    monkeypatch.setattr(m,'_UNKNOWN',False);monkeypatch.setattr(m,'sources',lambda *_:{})
    monkeypatch.setattr(m,'dependencies',lambda _:(sampler,child,relay,probe))
    monkeypatch.setattr(m.os,'lstat',Mock(side_effect=FileNotFoundError))
    monkeypatch.setattr(m.os,'pidfd_open',lambda _:7,raising=False);monkeypatch.setattr(m.os,'set_inheritable',lambda *_:None)
    monkeypatch.setattr(m,'live',lambda _:None);monkeypatch.setattr(m.os,'close',lambda _:None)
    monkeypatch.setattr(m.subprocess,'Popen',lambda *_a,**_k:process)
    stop=Mock(return_value=SimpleNamespace(returncode=0));monkeypatch.setattr(m.subprocess,'run',stop)
    monkeypatch.setattr(m.Capture,'open',Mock(side_effect=OSError('selector')))
    monkeypatch.setattr(m.Capture,'read',lambda *_a,**_k:None)
    report=m.run(hashes)
    assert report['commonViewValidated'] is False and m._UNKNOWN
    assert stop.call_args.args[0][-2:]==['stop',report['unit']]
    process.wait.assert_called_once()
    with pytest.raises(ValueError,match='PRIOR_UNKNOWN'):m.run(hashes)

@pytest.mark.parametrize('fail_after',[False,True,'finalseal','cancel_after_helper','cancel_finalseal'])
def test_real_owner_loop_orders_before_sample_and_holds_until_binding(monkeypatch,fail_after):
    full,hashes,_=complete_report();events=[]
    cancel=m.threading.Event()
    view=Mock();samples=iter([full['observerBefore'],full['observerAfter']])
    def sample():
        events.append('observer-sample');return next(samples)
    view.sample.side_effect=sample;view.close.return_value=True
    sampler=SimpleNamespace(open_self_view=lambda _:view,validate_common_view=fixtures.m.validate_common_view)
    child=SimpleNamespace(FILES=m.FILES[1:3]);relay=Mock();probe=Mock()
    relay.unit_absent.return_value=True;relay.manager_connection.return_value=full['manager']
    if fail_after=='cancel_after_helper':relay.unit_absent.side_effect=[True,False,True]
    relay.process_start_ticks.return_value=full['manager']['managerStartTimeTicks']
    bindings=[full['bindingBefore'],copy.deepcopy(full['bindingAfter'])]
    if fail_after is True:bindings[1]['unitMainStartTimeTicks']='101'
    relay.binding.side_effect=bindings;relay.exact_readback.return_value=full['readbackBefore']
    process=Mock(returncode=0);monkeypatch.setattr(m,'_UNKNOWN',False)
    monkeypatch.setattr(m.uuid,'uuid4',lambda:SimpleNamespace(hex='a'*32))
    monkeypatch.setattr(m,'sources',lambda *_:{})
    monkeypatch.setattr(m,'dependencies',lambda _:(sampler,child,relay,probe))
    monkeypatch.setattr(m.os,'lstat',Mock(side_effect=FileNotFoundError))
    monkeypatch.setattr(m.os,'pidfd_open',lambda _:7,raising=False)
    monkeypatch.setattr(m.os,'getuid',lambda:1000,raising=False)
    monkeypatch.setattr(m.os,'set_inheritable',lambda *_:None);monkeypatch.setattr(m.os,'set_blocking',lambda *_:None)
    monkeypatch.setattr(m,'live',lambda _:None);monkeypatch.setattr(m.os,'close',lambda _:None)
    stop=Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr(m.subprocess,'Popen',lambda *_a,**_k:process);monkeypatch.setattr(m.subprocess,'run',stop)
    monkeypatch.setattr(m,'exited_pin',lambda _:full['cleanup']['helperPinOutcome'])
    monkeypatch.setattr(m,'wait_main',lambda *_:None)
    monkeypatch.setattr(m,'process_generation',lambda *_:copy.deepcopy(full['mainBefore']))
    monkeypatch.setattr(m.Capture,'open',lambda *_:None)
    def capture(self,deadline,until_line=False):
        if until_line:
            self.stdout.extend(bytes.fromhex(full['rawStdoutHex']));events.append('helper-read')
            if fail_after=='cancel_after_helper':cancel.set()
        else:self.eof={'stdout':True,'stderr':True}
    monkeypatch.setattr(m.Capture,'read',capture)
    monkeypatch.setattr(m,'write_all',lambda fd,raw,deadline:events.append(m.strict(raw)['type']))
    if fail_after=='finalseal':
        original_validate=m.validate_report;original_check=m.check;expired=[False]
        def validate(*args):
            result=original_validate(*args);expired[0]=True;return result
        def checked(deadline):
            if expired[0]:raise ValueError('COMMON_SERVICE_DEADLINE')
            original_check(deadline)
        monkeypatch.setattr(m,'validate_report',validate);monkeypatch.setattr(m,'check',checked)
    if fail_after=='cancel_finalseal':
        original_validate=m.validate_report
        def validate(*args):
            result=original_validate(*args);cancel.set();return result
        monkeypatch.setattr(m,'validate_report',validate)
    value=m.run(hashes,_cancel_event=cancel)
    assert events[:4]==['observer-sample','common_view_sample','helper-read','observer-sample']
    assert value['commonViewValidated'] is (not fail_after)
    assert ('common_view_release' in events) is (fail_after is not True and fail_after!='cancel_after_helper')
    assert m._UNKNOWN is bool(fail_after)
    assert m._ACTIVE_CANCEL is None
    if fail_after=='cancel_after_helper':
        assert 'ValueError:COMMON_SERVICE_CANCELLED' in value['errors']
        assert value['cleanup']['localHandlesClosed'] is True
        assert stop.call_args.args[0][-2:]==['stop',value['unit']]
    if fail_after=='cancel_finalseal':
        assert 'ValueError:COMMON_SERVICE_CANCELLED' in value['errors']


def test_pre_cancelled_owner_never_loads_or_spawns(monkeypatch):
    cancel=m.threading.Event();cancel.set();monkeypatch.setattr(m,'_UNKNOWN',False)
    monkeypatch.setattr(m,'sources',lambda *_:pytest.fail('source work after cancellation'))
    monkeypatch.setattr(m.subprocess,'Popen',lambda *_a,**_k:pytest.fail('spawn after cancellation'))
    report=m.run({name:'a'*64 for name in m.FILES},_cancel_event=cancel)
    assert report['commonViewValidated'] is False and m._UNKNOWN and m._ACTIVE_CANCEL is None
    assert report['cleanup']['notSpawned'] is True
    assert 'ValueError:COMMON_SERVICE_CANCELLED' in report['errors']


def test_cancellation_object_cannot_run_arbitrary_poll_callback(monkeypatch):
    monkeypatch.setattr(m,'_UNKNOWN',False)
    with pytest.raises(ValueError,match='FIXED_CANCEL_EVENT'):
        m.run({},_cancel_event=Mock())

@pytest.mark.parametrize('case',['empty-socket','socket-owner','socket-type','socket-alias-pid','manager-cgroup','driver-pid','driver-cgroup','stat-prefix','pin-unknown','pin-bool'])
def test_private_manager_and_owned_exit_proof_cannot_be_self_consistent_only(case):
    value,hashes,deps=complete_report()
    if case=='empty-socket':value['manager']['managerSocket']={}
    elif case=='socket-owner':value['manager']['managerSocket']['components'][-1]['uid']=0
    elif case=='socket-type':value['manager']['managerSocket']['components'][-1]['mode']=0x41ed
    elif case=='socket-alias-pid':value['manager']['managerPid']=value['bindingBefore']['driverPid']
    elif case=='manager-cgroup':value['manager']['managerCgroup']='/other'
    elif case=='driver-pid':value['bindingBefore']['driverPid']=102
    elif case=='driver-cgroup':value['bindingBefore']['driverCgroup']='/other'
    elif case=='stat-prefix':
        raw=bytes.fromhex(value['mainBefore']['rawStatHex']).replace(b'202 (',b'999 (',1)
        value['mainBefore']['rawStatHex']=raw.hex();value['mainBefore']['rawStatSha256']=m.hashlib.sha256(raw).hexdigest()
    elif case=='pin-unknown':value['cleanup']['helperPinOutcome']=None
    elif case=='pin-bool':value['cleanup']['helperPinOutcome']['pollFlags']=True
    for k,v in value['manager'].items():value['bindingBefore'][k]=copy.deepcopy(v)
    value['bindingAfter']=copy.deepcopy(value['bindingBefore'])
    assert not m.validate_report(value,hashes,deps)


@pytest.mark.parametrize('flags,err,ok',[(1,3,True),(17,3,True),(1,None,False),(4,3,False),(0,3,False)])
def test_exit_pin_requires_actual_readiness_and_esrch(flags,err,ok):
    poll=Mock();poll.poll.return_value=[(7,flags)]
    signal_error=OSError(err,'fixed') if err is not None else None
    with patch.object(m.select,'poll',return_value=poll,create=True),patch.object(m.select,'POLLIN',1,create=True), \
         patch.object(m.select,'POLLHUP',16,create=True),patch.object(m.signal,'pidfd_send_signal',side_effect=signal_error,create=True):
        if ok:assert m.exited_pin(7)=={'exitReady':True,'pollFlags':flags,'signalZeroErrno':3}
        else:
            with pytest.raises(ValueError):m.exited_pin(7)

@pytest.mark.parametrize('absent,code,known',[(True,None,True),(False,0,True),(False,1,False)])
def test_stop_nonzero_never_hidden_by_later_absence(absent,code,known):
    process=Mock(returncode=0);capture=Mock();relay=Mock();probe=Mock()
    relay.unit_absent.side_effect=[absent,True]
    with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=code)) as stop, \
         patch.object(m.os,'lstat',side_effect=FileNotFoundError):
        result=m.cleanup(process,True,fixtures.UNIT,relay,probe,capture,None,[],m.time.monotonic()+5)
    assert result['localHandlesClosed'] is known
    assert stop.called is (not absent)
    assert result['unitAbsent'] is True
    assert ('UNIT_STOP_FAILED' in result['errors']) is (not known)
