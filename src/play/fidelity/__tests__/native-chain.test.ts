import {expect,it} from 'vitest';
import {nativeSpec} from '../../compose/native';
import {fidelityChain} from '../chain';
import {namedProps,propModels} from '../../arcade/models';
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
