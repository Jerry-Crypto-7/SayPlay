import copy
import importlib.util
from pathlib import Path
import stat
import unittest
spec=importlib.util.spec_from_file_location('boundary',Path(__file__).parents[1]/'subscription-cli-boundary-probe.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class BoundaryTests(unittest.TestCase):
    def sample(self):
        expected={'control':{'dev':1,'ino':2,'type':stat.S_IFIFO},'output':{'dev':1,'ino':3,'type':stat.S_IFIFO}}
        boundary={'paths':{name:{'opened':False,'errno':2,'identity':None} for name in p.PATHS},'descriptors':{name:{'opened':False,'bytesWritten':0,'errno':13,'identity':None} for name in p.DESCRIPTORS}}
        namespaces={'user':'user:[100]','mnt':'mnt:[200]','pid':'pid:[300]'}
        facts={'namespaces':namespaces,'outerNamespaces':{'mnt':'mnt:[201]','pid':'pid:[301]'},'ownOutputIdentity':{'dev':1,'ino':4,'type':stat.S_IFIFO},'expectedProtectedDescriptors':expected,'CapEff':'0000000000000000','CapBnd':'0000000000000000','NoNewPrivs':'1',
               'attempts':[{'method':m,'beforeNamespaces':namespaces.copy(),'afterNamespaceBoundary':None,'steps':[{'operation':'unshare-'+m,'succeeded':False,'errno':1}]} for m in ['combined','sequential']],
               'baseline':boundary,'cgroupBytesWritten':0,'descriptorBytesWritten':0,'credentialFilesRead':False}
        return facts,expected
    def success(self):
        facts,expected=self.sample()
        def step(name, **extra):
            return {'operation':name,'succeeded':True,'errno':None,**extra}
        for attempt in facts['attempts']:
            method=attempt['method']
            attempt['steps']=[step('unshare-'+method),*[step('new-namespace-map',path=path) for path in ['/proc/self/setgroups','/proc/self/uid_map','/proc/self/gid_map']]]
            if method=='sequential': attempt['steps'].append(step('unshare-mount'))
            attempt['steps'] += [{'operation':name,'succeeded':False,'errno':1} for name in ['mount-read-only-proc','mount-read-only-cgroup2']]
            detach={'operation':'detach-local-proc','succeeded':False,'errno':22}
            attempt['steps'].append(detach)
            attempt.update(afterNamespaces={'user':'user:[101]','mnt':'mnt:[202]','pid':'pid:[300]'},
                           afterNamespaceStatus={'CapEff':'000001ffffffffff','CapBnd':'000001ffffffffff','NoNewPrivs':'1'},
                           procMounts=[{'mountpoint':'/proc','filesystem':'proc'}],privateDescendantMountNamespace=True,
                           afterNamespaceBoundary=copy.deepcopy(facts['baseline']),afterMountBoundary=copy.deepcopy(facts['baseline']),
                           procLayers=[{'unmount':detach.copy(),'boundary':copy.deepcopy(facts['baseline'])}])
        return facts,expected
    def test_complete_success_and_einval_detach_observation_validate(self):
        self.assertTrue(p.validate(*self.success()))
    def test_placeholder_after_namespace_cannot_replace_operations(self):
        facts,expected=self.sample();attempt=facts['attempts'][0]
        attempt['steps'][0].update(succeeded=True,errno=None)
        attempt['afterNamespaces']={'mnt':'placeholder'}
        self.assertFalse(p.validate(facts,expected))
    def test_every_success_field_is_required(self):
        keys=['afterNamespaces','afterNamespaceStatus','procMounts','privateDescendantMountNamespace','afterNamespaceBoundary','afterMountBoundary','procLayers','beforeNamespaces']
        for key in keys:
            facts,expected=self.success();del facts['attempts'][0][key]
            with self.subTest(key=key):self.assertFalse(p.validate(facts,expected))
    def test_each_operation_is_required_and_ordered(self):
        facts,_=self.success()
        for method in range(2):
            for index in range(len(facts['attempts'][method]['steps'])):
                changed,expected=self.success();del changed['attempts'][method]['steps'][index]
                with self.subTest(method=method,index=index):self.assertFalse(p.validate(changed,expected))
        facts,expected=self.success();a=facts['attempts'][0]['steps'];a[1],a[2]=a[2],a[1]
        self.assertFalse(p.validate(facts,expected))
    def test_namespace_identity_and_private_guard_are_required(self):
        for key,value in [('user','user:[100]'),('mnt','mnt:[200]'),('pid','pid:[999]'),('mnt','placeholder')]:
            facts,expected=self.success();facts['attempts'][0]['afterNamespaces'][key]=value
            with self.subTest(key=key,value=value):self.assertFalse(p.validate(facts,expected))
        facts,expected=self.success();facts['attempts'][0]['privateDescendantMountNamespace']=False
        self.assertFalse(p.validate(facts,expected))
    def test_einval_unshare_is_not_permission_denial(self):
        facts,expected=self.sample();facts['attempts'][0]['steps'][0]['errno']=22
        self.assertFalse(p.validate(facts,expected))
    def test_sequential_mount_denial_requires_permission_errno(self):
        facts,expected=self.success();attempt=facts['attempts'][1]
        for key in list(attempt):
            if key not in ['method','beforeNamespaces','steps','afterNamespaceBoundary']:del attempt[key]
        attempt['steps']=attempt['steps'][:5];attempt['afterNamespaceBoundary']=None
        attempt['steps'][-1].update(succeeded=False,errno=22)
        self.assertFalse(p.validate(facts,expected))
        attempt['steps'][-1]['errno']=1
        self.assertTrue(p.validate(facts,expected))
    def test_missing_layer_snapshot_or_mismatched_step_rejected(self):
        facts,expected=self.success();facts['attempts'][0]['procLayers'][0]['boundary']={}
        self.assertFalse(p.validate(facts,expected))
        facts,expected=self.success();facts['attempts'][0]['procLayers'][0]['unmount']['errno']=1
        self.assertFalse(p.validate(facts,expected))
    def test_unknown_mount_error_has_no_permission_credit(self):
        facts,expected=self.success();facts['attempts'][0]['steps'][4]['errno']=22
        self.assertFalse(p.validate(facts,expected))
    def test_concrete_denials_validate(self):
        self.assertTrue(p.validate(*self.sample()))
    def test_visible_cgroup_is_not_isolated(self):
        facts,expected=self.sample();facts['baseline']['paths']['/sys/fs/cgroup']['opened']=True
        self.assertFalse(p.validate(facts,expected))
    def test_outer_descriptor_alias_is_rejected(self):
        facts,expected=self.sample();facts['baseline']['descriptors']['/proc/1/fd/1'].update(opened=True,errno=None,identity=expected['output'])
        self.assertFalse(p.validate(facts,expected))
    def test_nested_own_descriptor_is_not_outer(self):
        facts,expected=self.sample();facts['baseline']['descriptors']['/proc/1/fd/1'].update(opened=True,errno=None,identity={'dev':1,'ino':4,'type':stat.S_IFIFO})
        self.assertTrue(p.validate(facts,expected))
    def test_incomplete_success_has_no_credit(self):
        facts,expected=self.sample();facts['attempts'][0]['steps'][0]['succeeded']=True
        self.assertFalse(p.validate(facts,expected))
    def test_incomplete_observations_have_no_credit(self):
        facts,expected=self.sample();del facts['baseline']['paths']['/sys/fs/cgroup']
        self.assertFalse(p.validate(facts,expected))
    def test_no_control_pipe_no_control_credit(self):
        facts,expected=self.sample();expected['control']['type']=stat.S_IFCHR
        self.assertFalse(p.validate(facts,expected))
if __name__=='__main__':unittest.main()
