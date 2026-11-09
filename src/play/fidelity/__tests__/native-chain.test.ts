import {expect,it} from 'vitest';
import {nativeSpec} from '../../compose/native';
import {fidelityChain} from '../chain';
import {namedProps,propModels} from '../../arcade/models';
import {draftGameSpec} from '../../draft';

// P78 T3: kontrola „sloveso přečteno“ zná novější hry – nativní let (generátor `glide_course`) a hru, která nese žánr ve `spec.genre`.
it('a verb a newer game plays counts as read, a verb it does not play does not',()=>{
 const glide=nativeSpec({move:'glide',objective:'collect',actions:['collect'],threats:[]},{genre:'voyage',mode:'race',hero:'bird',setting:'canyon'});
 expect(fidelityChain(glide,[{item:'fly',slot:'verb',controls:['flap','steer']}])[0]?.why).toBe('ok');
 expect(fidelityChain(glide,[{item:'negotiate',slot:'verb',controls:[]}])[0]?.why).toBe('not-in-spec');
 const sorting=draftGameSpec('sort the parcels into the right bins at the post office');
 expect(sorting.genre?.id).toBe('sort');
 expect(fidelityChain(sorting,[{item:'sort',slot:'verb',controls:['timing']}])[0]?.why).toBe('ok');
 expect(fidelityChain(sorting,[{item:'fly',slot:'verb',controls:['flap']}])[0]?.why).toBe('not-in-spec');
});
it('the live glide collectible is read and drawn by the body-driven named prop contract',()=>{
 const spec=nativeSpec({move:'glide',objective:'collect',actions:['collect'],threats:[]},{genre:'voyage',mode:'race',hero:'fish',setting:'reef',cast:[{label:'coin',does:'collect'}]});
 expect(namedProps(spec).coin).toBe('coin');expect(propModels(spec).coin).toBe('coin');
 expect(fidelityChain(spec,[{item:'coin',slot:'role',match:['coin']}])[0]).toMatchObject({inSpec:true,read:true,drawn:true});
 const phantom={...spec,roles:[...spec.roles,{id:'phantom',kind:'collectible' as const,label:'trophy',count:1}]};
 expect(fidelityChain(phantom,[{item:'trophy',slot:'role',match:['trophy']}])[0]).toMatchObject({inSpec:true,read:false,drawn:false});
});
it('declaring a guard does not create a guard in a labyrinth',()=>{
 const spec=nativeSpec({move:'walk',objective:'reach',actions:[],threats:[]},{genre:'quest',mode:'spatial',hero:'cat',setting:'house'});
 const phantom={...spec,roles:[...spec.roles,{id:'guard',kind:'patrol' as const,label:'robot',count:1}]};
 expect(fidelityChain(phantom,[{item:'robot',slot:'role',match:['robot']}])[0]).toMatchObject({inSpec:true,read:false,drawn:false});
});

it('an exact requested identity is not lost merely because the alias list omits it',()=>{
 const spec=nativeSpec({move:'walk',objective:'reach',actions:[],threats:['guard']},{genre:'quest',mode:'spatial',hero:'cat',setting:'house',cast:[{label:'in-law',does:'chase_me'}]});
 expect(fidelityChain(spec,[{item:'in-laws',slot:'role',match:['family','relatives']}])[0]).toMatchObject({inSpec:true,read:true});
 expect(fidelityChain(spec,[{item:'coworkers',slot:'role',match:[]}])[0]).toMatchObject({inSpec:false,read:false});
});
