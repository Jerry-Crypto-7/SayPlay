"""Offline receiver tests; no sockets, SCM transfers or exec are performed."""
import array
import errno
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import struct
import sys
import pytest

spec = importlib.util.spec_from_file_location('receiver_test', Path(__file__).with_name('subscription-systemd-ingress-receiver.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ARGS = ['--handoff', 'a'*32, 'b'*32, '123', '456', '0', '789']
EXPECTED = m.arguments(ARGS)
SOCKET = {'dev': 1, 'ino': 2, 'type': 49152, 'family': 1, 'socketType': 1}


@pytest.mark.parametrize('index,value', [(0,'--exec'), (1,'A'*32), (2,'b'*33), (3,'1'), (3,'2147483648'), (3,'0123'), (4,'-1'), (4,'9'*20), (5,'00'), (6,'0')])
def test_fixed_arguments_only(index,value):
    args = list(ARGS); args[index] = value
    with pytest.raises(ValueError): m.arguments(args)


def test_exact_args_and_no_caller_command():
    assert EXPECTED['controllerPid'] == 123 and EXPECTED['socketIno'] == 789
    with pytest.raises(ValueError): m.arguments(ARGS + ['extra'])
    assert m.COMMAND[-1] == '--trusted-ingress-fd'


@pytest.mark.parametrize('case', ['valid','extra','truncated','wrong-marker','foreign','unaligned','expired'])
def test_ancillary_admission_closes_all_received_fds_on_rejection(case):
    values = [42,43] if case == 'extra' else [42]
    body = array.array('i',values).tobytes() + (b'x' if case == 'unaligned' else b'')
    ancillary = [(1,1,body)] + ([(2,99,b'foreign')] if case == 'foreign' else [])
    channel = Mock(recvmsg=Mock(return_value=(b'X' if case == 'wrong-marker' else b'F', ancillary, 8 if case == 'truncated' else 0, None)))
    ticks = iter([0.0, 6.0] if case == 'expired' else [0.0,0.0])
    with patch.object(m.socket,'SCM_RIGHTS',1,create=True), patch.object(m.socket,'SOL_SOCKET',1), \
         patch.object(m.socket,'MSG_CMSG_CLOEXEC',0x40000000,create=True), patch.object(m.socket,'MSG_DONTWAIT',64,create=True), \
         patch.object(m.socket,'MSG_TRUNC',32,create=True), patch.object(m.socket,'MSG_CTRUNC',8,create=True), \
         patch.object(m.socket,'CMSG_SPACE',lambda size:size+16,create=True), patch.object(m.os,'close') as close, \
         patch.object(m.time,'monotonic',side_effect=lambda:next(ticks)):
        if case == 'valid': assert m.receive_fd(channel,5)==42; close.assert_not_called()
        else:
            with pytest.raises((ValueError,TimeoutError)): m.receive_fd(channel,5)
            assert [call.args[0] for call in close.call_args_list] == values


@pytest.mark.parametrize('case',['valid','extra-key','bool-version','nonce','socket-bool','second-line'])
def test_offer_reads_one_byte_without_overreading_fd_marker(case):
    frame = {'version':1,'type':'fd_offer','uuid':'a'*32,'nonce':'b'*32,'socket':dict(SOCKET)}
    if case=='extra-key': frame['path']='/arbitrary'
    if case=='bool-version': frame['version']=True
    if case=='nonce': frame['nonce']='c'*32
    if case=='socket-bool': frame['socket']['ino']=True
    raw = json.dumps(frame).encode()+b'\n'+b'F'
    channel=Mock(recv=Mock(side_effect=[bytes([v]) for v in raw]))
    if case in ('valid','second-line'):
        assert m.receive_offer(channel,EXPECTED,m.time.monotonic()+5)==SOCKET
        assert channel.recv.call_count==len(raw)-1
    else:
        with pytest.raises(ValueError): m.receive_offer(channel,EXPECTED,m.time.monotonic()+5)
    assert all(call.args==(1,) for call in channel.recv.call_args_list)


@pytest.mark.parametrize('case',['valid','pid','uid','gid','generation','inside','wrongunit'])
def test_peer_generation_and_leaf_binding(case):
    raw=struct.pack('=3i',999 if case=='pid' else 123,999 if case=='uid' else 1000,999 if case=='gid' else 1000)
    own='/user.slice/codex-cli-resource-'+('c'*32 if case=='wrongunit' else 'a'*32)+'.service'
    controller={'startTicks':'999' if case=='generation' else '456','cgroup':own if case=='inside' else '/user.slice/controller'}
    with patch.object(m.os,'getuid',return_value=1000,create=True), patch.object(m.os,'getgid',return_value=1000,create=True), \
         patch.object(m.socket,'SO_PEERCRED',17,create=True), patch.object(m.signal,'pidfd_send_signal',create=True), \
         patch.object(m,'metadata',side_effect=[controller,{'startTicks':'789','cgroup':own}]):
        if case=='valid': assert m.peer_identity(Mock(getsockopt=Mock(return_value=raw)),EXPECTED,88)==controller
        else:
            with pytest.raises(ValueError): m.peer_identity(Mock(getsockopt=Mock(return_value=raw)),EXPECTED,88)


def test_reserve_occupied198_does_not_overwrite_or_close_caller_fd():
    info=SimpleNamespace(st_mode=0o140777,st_dev=1,st_ino=2)
    wrapper=Mock(family=1,getsockopt=Mock(side_effect=[1,0]))
    fcntl=SimpleNamespace(F_DUPFD_CLOEXEC=1030,fcntl=Mock())
    with patch.dict(sys.modules,{'fcntl':fcntl}), patch.object(m.os,'get_inheritable',return_value=False), patch.object(m.os,'fstat',return_value=info), \
         patch.object(m.socket,'socket',return_value=wrapper), patch.object(m.socket,'AF_UNIX',1,create=True),patch.object(m.os,'close') as close:
        with pytest.raises(ValueError,match='FD198_OCCUPIED'):m.reserve_fd(42,SOCKET)
        fcntl.fcntl.assert_not_called();close.assert_not_called();wrapper.detach.assert_called_once()


@pytest.mark.parametrize('case',['valid','symlink','owner','directory-mode','socket-mode','identity'])
def test_private_path_components_no_follow_and_exact_inode(case):
    entries=[SimpleNamespace(st_mode=0o40755,st_uid=0,st_dev=0,st_ino=i+1) for i in range(5)]
    entries[2].st_uid=1000
    entries[3]=SimpleNamespace(st_mode=0o40700,st_uid=1000,st_dev=0,st_ino=99)
    entries[4]=SimpleNamespace(st_mode=0o140600,st_uid=1000,st_dev=0,st_ino=789)
    if case=='symlink':entries[1].st_mode=0o120777
    if case=='owner':entries[3].st_uid=999
    if case=='directory-mode':entries[3].st_mode=0o40777
    if case=='socket-mode':entries[4].st_mode=0o140666
    if case=='identity':entries[4].st_ino=790
    with patch.object(m.os,'getuid',return_value=1000,create=True),patch.object(m.os,'lstat',side_effect=entries):
        if case=='valid': assert m.path_identity(EXPECTED)[0]=='/run/user/1000/rc-ingress-'+('a'*32)+'/handoff.sock'
        else:
            with pytest.raises(ValueError):m.path_identity(EXPECTED)


@pytest.mark.parametrize('selector,command',[('--handoff',m.COMMAND),('--http-handoff',m.HTTP_COMMAND)])
def test_fixed_exec_closes_channel_pin_and_duplicate_before_inheriting_only198(selector,command):
    class ExecReached(BaseException):pass
    events=[]
    channel=Mock(close=Mock(side_effect=lambda:events.append('channel-close')))
    def execute(binary,argv,env):
        assert binary=='/usr/bin/timeout' and argv==command
        assert env=={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}
        assert 'channel-close' in events and 88 in events and 42 in events and 77 in events
        assert 198 not in events
        raise ExecReached()
    with patch.object(m,'path_identity',return_value=('fixed',[])),patch.object(m.socket,'socket',return_value=channel), \
         patch.object(m.socket,'AF_UNIX',1,create=True),patch.object(m.os,'pidfd_open',return_value=88,create=True), \
         patch.object(m,'peer_identity',return_value={'startTicks':'456','cgroup':'/outside'}),patch.object(m,'metadata',return_value={'startTicks':'999'}), \
         patch.object(m,'send_frame'),patch.object(m,'receive_offer',return_value=SOCKET),patch.object(m,'receive_fd',return_value=42), \
         patch.object(m,'reserve_fd',return_value=198),patch.object(m.os,'close',side_effect=lambda fd:events.append(fd)), \
         patch.object(m.os,'listdir',return_value=['0','1','2','77','198']),patch.object(m.os,'set_inheritable') as inheritable, \
         patch.object(m.os,'execve',side_effect=execute):
        with pytest.raises(ExecReached):m.run(m.arguments([selector,*ARGS[1:]]))
        inheritable.assert_called_once_with(198,True)
    assert events[-1]==198


def test_http_selector_is_explicit_and_preserves_all_inner_bounds():
    parsed=m.arguments(['--http-handoff',*ARGS[1:]])
    assert parsed=={**EXPECTED,'profile':'http'}
    assert m.fixed_command(parsed)==m.HTTP_COMMAND
    assert m.HTTP_COMMAND[:-1]==m.COMMAND[:-1]
    assert m.HTTP_COMMAND[-1]=='--trusted-http-ingress-fd'
    assert m.fixed_command(EXPECTED)[-1]=='--trusted-ingress-fd'
    with pytest.raises(ValueError):m.arguments(['--http-handoff',*ARGS[1:],'--trusted-ingress-fd'])
    with pytest.raises(ValueError):m.fixed_command({**EXPECTED,'profile':'arbitrary'})
