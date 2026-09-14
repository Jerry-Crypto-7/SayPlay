"""Exclusive source-bound capsule selector; no CLI or OS workload is run."""
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import pytest

p=Path(__file__).with_name('subscription-cli-supervisor.py')
spec=importlib.util.spec_from_file_location('trusted_cli_supervisor',p)
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)


def test_exclusive_mode_closes_all_inherited_descriptors_before_reexec():
    s.require_launch_profile(s.TRUSTED_CLI_MODE,None,cli_worker=True)
    for mode in s.MODES:
        if mode!=s.TRUSTED_CLI_MODE:
            with pytest.raises(ValueError):s.require_launch_profile(mode,None,cli_worker=True)
    with pytest.raises(ValueError):s.require_launch_profile(s.TRUSTED_CLI_MODE,None)
    with patch.object(s.os,'closerange') as close,patch.object(s,'inspect_ingress_fd') as inspect:
        assert s.prepare_reexec(None,cli_worker=True)==['--inside-trusted-cli-worker-boundary']
        close.assert_called_once_with(3,65536);inspect.assert_not_called()


@pytest.mark.parametrize('extra',[dict(http_ingress=True),dict(cli_proxy_refusal=True),
    dict(cgroup_worker=True),dict(stress_phase='tasks'),dict(stress_phase='memory')])
def test_mixed_profiles_refused_before_fd_change_or_launch(extra):
    with patch.object(s.os,'closerange') as close,patch.object(s.subprocess,'Popen') as launch:
        with pytest.raises(ValueError):s.prepare_reexec(None,cli_worker=True,**extra)
        with pytest.raises(ValueError):s.main(cli_worker=True,**extra)
        close.assert_not_called();launch.assert_not_called()


@pytest.mark.parametrize('value',[0,1,None,'true'])
def test_profile_requires_actual_boolean_before_fd_change(value):
    with patch.object(s.os,'closerange') as close:
        with pytest.raises(ValueError):s.prepare_reexec(None,cli_worker=value)
        close.assert_not_called()


def test_control_requires_exact_twelve_hashes_and_cannot_supply_command_or_ingress():
    frame=dict(type='start',mode=s.TRUSTED_CLI_MODE,helperSha256=dict.fromkeys(s.TRUSTED_CLI_FILES,'a'*64))
    assert len(s.TRUSTED_CLI_FILES)==12
    assert s.parse_frame(json.dumps(frame).encode())==frame
    for change in (dict(helperSha256={}),dict(argv=['login']),dict(fd=198),dict(nonce='a'*32),dict(scenario='normal')):
        with pytest.raises(ValueError):s.parse_frame(json.dumps({**frame,**change}).encode())
    assert s.fixed_command(s.TRUSTED_CLI_MODE)==['/usr/bin/python3','-I','-S','/usr/bin/trusted-cli-worker-child.py']
    with pytest.raises(ValueError):s.fixed_command(s.TRUSTED_CLI_MODE,'normal')
    with pytest.raises(ValueError):s.fixed_arguments(s.TRUSTED_CLI_MODE)


def test_helper_inventory_matches_actual_child_and_conditional_shell_image():
    path=Path(__file__).with_name('subscription-trusted-cli-worker-child.py')
    spec=importlib.util.spec_from_file_location('trusted_cli_helper_inventory',path)
    child=importlib.util.module_from_spec(spec);spec.loader.exec_module(child)
    assert s.TRUSTED_CLI_FILES==child.HELPERS
    shell=Path(__file__).with_name('subscription-cli-supervisor.sh').read_text()
    start=shell.index('if [ "${1-}" = \'--trusted-cli-worker-boundary\' ]; then')
    block=shell[start:shell.index('\nfi',start)]
    extras=set(s.TRUSTED_CLI_FILES)-set(s.TRUSTED_CONTROL_FILES)
    assert len(extras)==4 and block.count('\n  cp ')==4
    for name in extras:
        assert '/mnt/d/claude/Hackaton/scripts/'+name in block
        assert '$root'+s.TRUSTED_CLI_FILES[name] in block
