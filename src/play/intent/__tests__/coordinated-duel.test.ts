import {expect,it} from 'vitest';
import {extractIntent} from '@/play/intent/extract';
it.each([['a cat and dog duel','cat','dog'],['a wizard and another wizard argue','wizard','wizard'],['the robot and alien duel','robot','alien']])('preserves both coordinated duel participants: %s',(sentence,actor,object)=>{const intent=extractIntent(sentence);expect(intent.hero).toBe(actor);expect(intent.items.some(item=>item.essential&&item.verb==='duel'&&item.actor===actor&&item.object===object)).toBe(true);});
it('does not pair subjects from separate actions',()=>{const intent=extractIntent('a cat runs and a dog duels a fox');expect(intent.items.some(item=>item.verb==='duel'&&item.actor==='cat'&&item.object==='dog')).toBe(false);});
