"""Offline handoff tests: no unit, pathname socket, FD transfer or runtime."""
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import array
import json
import struct
import pytest

spec=importlib.util.spec_from_file_location('rendezvous_test',Path(__file__).with_name('subscription-systemd-ingress-rendezvous.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def prepared():
    obj=m.Rendezvous.__new__(m.Rendezvous)
    obj.uuid='a'*32;obj.nonce='b'*32;obj.unit='codex-cli-resource-'+obj.uuid+'.service'
    obj.path='/fixed-owned';obj.socket_path='/fixed-owned/handoff.sock'
    obj._cleanup_result=None;obj._path_cleanup={'socketRemoved':False,'directoryRemoved':False}
    obj.directory_identity=None;obj.socket_identity=None;obj.closed=False;obj.used=False;obj.transferred=False;obj.pin=None;obj.channel=None
    channel=Mock(fileno=Mock(return_value=-1),getsockopt=Mock(return_value=struct.pack('=3i',123,1000,1000)),sendmsg=Mock(return_value=1))
    obj.listener=Mock(accept=Mock(return_value=(channel,None)),fileno=Mock(return_value=-1))
    ingress=Mock(family=1,fileno=Mock(return_value=42),getsockopt=Mock(return_value=1))
    obj.peers=(ingress,Mock(fileno=Mock(return_value=-1)),Mock(fileno=Mock(return_value=-1)))
    obj.broker=SimpleNamespace(_sockets=())
    control={'unitMainPid':123,'unitMainStartTimeTicks':'456'}
    obj.modules=SimpleNamespace(receiver=Mock(),relay=Mock(binding=Mock(return_value=control),exact_readback=Mock(return_value={'memoryMax':'2147483648','memorySwapMax':'0','pidsMax':'64'})),probe=object())
    obj._check_path=Mock();obj._sources_match=Mock(return_value=True)
    info={'dev':1,'ino':2,'type':49152,'family':1,'socketType':1}
    hello={'version':1,'type':'receiver_hello','uuid':obj.uuid,'nonce':obj.nonce,'pid':123,'startTicks':'456'}
    ack={'version':1,'type':'fd_received','uuid':obj.uuid,'nonce':obj.nonce,'fd':198,'socket':info}
    return obj,channel,hello,ack


@pytest.mark.parametrize('case',['valid','peer','hello','readback','prebinding','send','ack','postbinding','timeout'])
def test_exact_mainpid_readback_and_single_transfer_with_unknown_fence(case):
    obj,channel,hello,ack=prepared()
    if case=='peer':channel.getsockopt.return_value=struct.pack('=3i',999,1000,1000)
    if case=='hello':hello['pid']=True
    if case=='readback':obj.modules.relay.exact_readback.side_effect=ValueError('limit')
    if case=='prebinding':obj.modules.relay.binding.side_effect=[{'unitMainPid':123,'unitMainStartTimeTicks':'456'},{'unitMainPid':999}]
    if case=='postbinding':obj.modules.relay.binding.side_effect=[{'unitMainPid':123,'unitMainStartTimeTicks':'456'}]*2+[{'unitMainPid':999}]
    if case=='send':channel.sendmsg.side_effect=BlockingIOError()
    if case=='ack':ack['nonce']='c'*32
    if case=='timeout':obj.modules.receiver.check_time.side_effect=TimeoutError('setup')
    with patch.object(m,'_FENCED',False),patch.object(m.os,'getuid',return_value=1000,create=True),patch.object(m.os,'getgid',return_value=1000,create=True), \
         patch.object(m.os,'pidfd_open',return_value=88,create=True),patch.object(m.signal,'pidfd_send_signal',create=True),patch.object(m.os,'close'), \
         patch.object(m.socket,'SO_PEERCRED',17,create=True),patch.object(m.socket,'SCM_RIGHTS',1,create=True),patch.object(m.socket,'MSG_DONTWAIT',64,create=True), \
         patch.object(m.os,'fstat',return_value=SimpleNamespace(st_dev=1,st_ino=2,st_mode=0o140777)),patch.object(m,'receive_plain',side_effect=[hello,ack]):
        if case=='valid':
            report=obj.transfer({'manager':'fixed'},99)
            assert report['transferObserved'] and report['remoteCleanup']=='NOT_ATTESTED'
            args=channel.sendmsg.call_args.args
            assert args[0]==[b'F'] and array.array('i',args[1][0][2]).tolist()==[42]
            assert not m._FENCED
        else:
            with pytest.raises((ValueError,OSError)):obj.transfer({'manager':'fixed'},99)
            assert m._FENCED
            assert channel.sendmsg.call_count==(1 if case in ('send','ack','postbinding') else 0)
        with pytest.raises(ValueError):obj.transfer({},99)


def test_unexpected_rights_on_plain_frame_closed_and_rejected():
    channel=Mock(recvmsg=Mock(return_value=(b'X',[(1,1,array.array('i',[40,41]).tobytes())],0,None)))
    with patch.object(m.socket,'SOL_SOCKET',1),patch.object(m.socket,'SCM_RIGHTS',1,create=True), \
         patch.object(m.socket,'MSG_CMSG_CLOEXEC',0x40000000,create=True),patch.object(m.socket,'MSG_DONTWAIT',64,create=True), \
         patch.object(m.socket,'MSG_TRUNC',32,create=True),patch.object(m.socket,'MSG_CTRUNC',8,create=True),patch.object(m.socket,'CMSG_SPACE',lambda x:x+16,create=True),patch.object(m.os,'close') as close:
        with pytest.raises(ValueError):m.receive_plain(channel,m.time.monotonic()+5)
        assert [call.args[0] for call in close.call_args_list]==[40,41]


def test_source_hash_admission_before_import_and_global_fence():
    hashes={name:hashlib.sha256((m.ROOT/name).read_bytes()).hexdigest() for name in m.SOURCES}
    hashes[m.SOURCES[1]]='0'*64
    with patch.object(m.importlib.util,'module_from_spec') as imported:
        with pytest.raises(ValueError,match='SOURCE_DRIFT'):m.load_modules(hashes)
        imported.assert_not_called()
    with patch.object(m,'_FENCED',True),patch.object(m,'load_modules') as loaded:
        with pytest.raises(ValueError,match='UNCERTAIN'):m.create_rendezvous(hashes)
        loaded.assert_not_called()


def test_cleanup_refuses_foreign_replaced_directory_without_unlink():
    obj,_,_,_=prepared();obj.directory_identity=(1,2,0o40700,1000);obj.socket_identity=(1,3,0o140600,1000)
    obj._check_path=Mock(side_effect=ValueError('replaced'))
    with patch.object(m,'_FENCED',False),patch.object(m.os,'unlink') as unlink,patch.object(m.os,'rmdir') as rmdir:
        assert not obj.close() and m._FENCED
        unlink.assert_not_called();rmdir.assert_not_called()


@pytest.mark.parametrize('case',['not-started','valid','unknown-thread','source-drift'])
def test_finish_is_idempotent_and_safe_before_route_with_separate_cleanup(case):
    import threading
    obj,_,_,_=prepared()
    obj._final_route=None;obj.route_started=case!='not-started';obj.route_stop=threading.Event()
    obj.route_threads=[] if case=='not-started' else [Mock(is_alive=Mock(return_value=case=='unknown-thread')) for _ in range(2)]
    obj.route_errors=[];obj.route_counts={'beforeBytes':40,'afterBytes':39,'eof':True}
    obj.route_reports=[{'reason':'EOF','brokerDescriptorsClosed':True}]
    obj.peers[0].fileno.return_value=-1
    if case=='source-drift':obj._sources_match.return_value=False
    with patch.object(m,'_FENCED',False):
        result=obj.finish_route()
        assert result['passed'] is (case=='valid')
        assert result['remoteUnitCleanup']=='NOT_ATTESTED'
        assert obj.finish_route() is result
        assert m._FENCED is (case!='valid')


def test_constructor_never_adopts_existing_private_directory():
    module=SimpleNamespace(proxy=Mock())
    directory=SimpleNamespace(st_mode=0o40700,st_uid=1000)
    with patch.object(m,'_FENCED',False),patch.object(m,'load_modules',return_value=module), \
         patch.object(m.os,'getuid',return_value=1000,create=True),patch.object(m.os,'lstat',return_value=directory), \
         patch.object(m.os,'mkdir',side_effect=FileExistsError()),patch.object(m.os,'unlink') as unlink,patch.object(m.os,'rmdir') as rmdir,patch.object(m.socket,'socket') as create:
        with pytest.raises(FileExistsError):m.create_rendezvous({})
        create.assert_not_called();unlink.assert_not_called();rmdir.assert_not_called()


def test_source_drift_blocks_ancillary_send_even_after_valid_hello_offer():
    obj,channel,hello,ack=prepared();obj._sources_match.return_value=False
    with patch.object(m,'_FENCED',False),patch.object(m.os,'getuid',return_value=1000,create=True),patch.object(m.os,'getgid',return_value=1000,create=True), \
         patch.object(m.os,'pidfd_open',return_value=88,create=True),patch.object(m.signal,'pidfd_send_signal',create=True),patch.object(m.os,'close'),patch.object(m.socket,'SO_PEERCRED',17,create=True), \
         patch.object(m.os,'fstat',return_value=SimpleNamespace(st_dev=1,st_ino=2,st_mode=0o140777)),patch.object(m,'receive_plain',side_effect=[hello,ack]):
        with pytest.raises(ValueError,match='SOURCE_DRIFT'):obj.transfer({},99)
        channel.sendmsg.assert_not_called()


@pytest.mark.parametrize('case',['directory-lstat','socket-lstat'])
def test_created_path_without_captured_identity_is_unknown_never_unlinked(case):
    module=SimpleNamespace(proxy=Mock())
    parent=SimpleNamespace(st_mode=0o40700,st_uid=1000,st_dev=1,st_ino=1)
    own=SimpleNamespace(st_mode=0o40700,st_uid=1000,st_dev=1,st_ino=2)
    sequence=[parent,parent,parent,OSError('metadata denied')] if case=='directory-lstat' else [parent,parent,parent,own,OSError('socket metadata denied'),own]
    listener=Mock(fileno=Mock(return_value=-1))
    with patch.object(m,'_FENCED',False),patch.object(m,'load_modules',return_value=module),patch.object(m.os,'getuid',return_value=1000,create=True), \
         patch.object(m.os,'lstat',side_effect=sequence),patch.object(m.os,'mkdir'),patch.object(m.os,'chmod'),patch.object(m.os,'unlink') as unlink, \
         patch.object(m.os,'rmdir',side_effect=OSError('not empty')) as rmdir,patch.object(m.socket,'AF_UNIX',1,create=True),patch.object(m.socket,'socket',return_value=listener):
        with pytest.raises(OSError):m.create_rendezvous({})
        assert m._FENCED
        unlink.assert_not_called()
        if case=='directory-lstat':rmdir.assert_not_called()
        else:listener.close.assert_called_once()

@pytest.mark.parametrize('profile,selector',[('ingress','--handoff'),('http','--http-handoff')])
def test_fixed_receiver_profile_selects_only_literal_selector(profile,selector):
    obj=m.Rendezvous.__new__(m.Rendezvous)
    obj.profile=profile;obj.closed=False;obj.uuid='a'*32;obj.nonce='b'*32;obj.socket_identity=(1,2)
    obj.modules=SimpleNamespace(relay=SimpleNamespace(process_start_ticks=lambda pid:'456'))
    argv=obj.receiver_argv()
    assert argv[4]==selector and argv[5:7]==('a'*32,'b'*32)
    assert len(argv)==11 and argv[:3]==('/usr/bin/python3','-I','-S')


def test_public_http_factory_has_no_command_adoption():
    with patch.object(m,'Rendezvous') as constructor:
        m.create_http_rendezvous({'fixed':'hash'})
        constructor.assert_called_once_with({'fixed':'hash'},'http')
    with pytest.raises(ValueError,match='PROFILE'):m.Rendezvous({},'--arbitrary-command')
