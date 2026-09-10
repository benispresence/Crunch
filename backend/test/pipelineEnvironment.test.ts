import assert from 'node:assert/strict';
import { it } from 'node:test';
import { publicEnvironment, readEnvironment, saveEnvironment, redactEnvironment } from '../src/services/pipelineEnvironment.ts';
it('encrypts secrets, masks reads, preserves untouched secrets, rotates and deletes', () => {
  const stored = saveEnvironment({entries:[{name:'API_TOKEN',value:'unique-secret-value',secret:true},{name:'REGION',value:'eu',secret:false}]},'');
  assert.ok(!stored.includes('unique-secret-value'));
  assert.equal(publicEnvironment(stored).entries[0].value,null);
  const preserved = saveEnvironment(publicEnvironment(stored),stored);
  assert.equal(readEnvironment(preserved)[0].value,'unique-secret-value');
  const rotated = saveEnvironment({entries:[{name:'API_TOKEN',value:'new-secret',secret:true}]},preserved);
  assert.deepEqual(readEnvironment(rotated),[{name:'API_TOKEN',value:'new-secret',secret:true}]);
  assert.deepEqual(readEnvironment(saveEnvironment({entries:[]},rotated)),[]);
  assert.throws(()=>saveEnvironment({entries:[{name:'MISSING',value:null,secret:true}]},''));
});
it('rejects duplicate and reserved names and recursively masks run output', () => {
  for(const name of ['PATH','PYTHONPATH','LD_PRELOAD','invalid-name']) assert.throws(()=>saveEnvironment({entries:[{name,value:'x',secret:false}]},''));
  assert.throws(()=>saveEnvironment({entries:[{name:'X',value:'1',secret:false},{name:'X',value:'2',secret:true}]},''));
  assert.deepEqual(redactEnvironment({log:'token abc123',rows:[{x:'abc123'}]},['abc123']),{log:'token [REDACTED]',rows:[{x:'[REDACTED]'}]});
});
