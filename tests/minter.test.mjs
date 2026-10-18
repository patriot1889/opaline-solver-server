import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMinter, createMinter } from '../dist/minter.js';
import { MintBudget, integrityEndpoint } from '../dist/mint-budget.js';
import { ServiceError } from '../dist/errors.js';
import { pageConfig, pageChallenge } from '../dist/network.js';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';

const binding = 'OpalineTV+1/';
function state(mint, close = async () => {}) { return { expires: Date.now()+60000, close, value: { mintAsWebsafeString: mint } }; }

test('endpoint configuration is an explicit allowlist', () => {
  assert.equal(integrityEndpoint('google'),'google'); assert.equal(integrityEndpoint('youtube'),'youtube');
  for (const value of ['', 'auto', 'https://evil.test', 'Google']) assert.throws(()=>integrityEndpoint(value));
});
test('page markers tolerate whitespace and ignore non-object calls; strings and extraction bounds are respected', () => {
  assert.deepEqual(pageConfig('ytcfg.set(data); ytcfg.set( \n {"EVENT_ID":"event","nested":{"s":"})\\\"{"}});'), { EVENT_ID:'event', nested:{s:'})"{'} });
  assert.deepEqual(pageChallenge('window.ytAtN( \n {"R":{"bgChallenge":{"program":"})", "globalName":"guard"}}});'), { program:'})',globalName:'guard' });
  assert.equal(pageChallenge('no embedded challenge'),undefined);
  assert.throws(()=>pageConfig('ytcfg.set({"long":"'+'a'.repeat(2*1024*1024)+'"})'),/page_data_incomplete/);
  assert.throws(()=>pageChallenge('window.ytAtN({bad'),/page_data_incomplete/);
});
test('retry refreshes state, switches rejected integrity route, and preserves client/binding', async () => {
  const attempts=[], mints=[]; let closed=0;
  const service=new TokenMinter('TVHTML5','google',async (client,route,budget)=>{
    attempts.push({client,route,deadline:budget.deadline});
    if(attempts.length===1)throw new ServiceError('integrity_token_rejected');
    return state(async value=>{mints.push(value);return 'fresh_token';},async()=>{closed++});
  });
  assert.equal((await service.mint(binding,false)).poToken,'fresh_token');
  assert.deepEqual(attempts.map(a=>[a.client,a.route]),[['TVHTML5','google'],['TVHTML5','youtube']]);
  assert.equal(attempts[0].deadline,attempts[1].deadline);
  assert.deepEqual(mints,[binding]);
  assert.equal((await service.mint(binding,false)).cache,'hit');
  await service.mint(binding,true); assert.equal(closed,1);assert.equal(attempts.length,3);
});
test('failed cached minter is discarded before exactly one retry; stale binding tokens are cleared',async()=>{
  let initialized=0,closed=0; const bindings=[];
  const service=new TokenMinter('WEB','youtube',async()=>{
    const generation=++initialized;
    return state(async value=>{bindings.push(value);if(generation===1 && value==='second')throw new Error('sensitive upstream detail');return `token_${generation}`;},async()=>{closed++});
  });
  await service.mint('first',false);
  assert.equal((await service.mint('second',false)).poToken,'token_2');
  assert.equal(closed,1);assert.equal(initialized,2);
  assert.equal((await service.mint('first',false)).cache,'miss');
  assert.deepEqual(bindings,['first','second','second','first']);
});
test('retry count is capped and terminal validation failures do not retry',async()=>{
  for(const [code,expected] of [['token_mint_failed',2],['untrusted_interpreter',1],['client_context_mismatch',1],['page_event_id_missing',1]]){
    let attempts=0;
    const service=new TokenMinter('TVHTML5','google',async()=>{attempts++;throw new ServiceError(code)});
    await assert.rejects(service.mint(binding,false),e=>e.code===code);assert.equal(attempts,expected);
  }
});
test('retry does not start with insufficient remaining budget',async()=>{
  let attempts=0;
  const service=new TokenMinter('WEB','google',async()=>{attempts++;throw new ServiceError('integrity_token_rejected')});
  await assert.rejects(service.mint('video',false,Date.now()+1000),/integrity_token_rejected/);assert.equal(attempts,1);
});
test('deadline stops a stalled mint, clears the state, and does not retry',async()=>{
  let attempts=0,closed=0;
  const service=new TokenMinter('WEB','google',async()=>{attempts++;return state(()=>new Promise(()=>{}),async()=>{closed++})});
  const start=performance.now();
  await assert.rejects(service.mint('video',false,Date.now()+50),e=>e.code==='mint_deadline' && e.status===504);
  assert.equal(attempts,1);assert.equal(closed,1);assert.ok(performance.now()-start<1000);
});
test('download cancellation reaches the upstream fetch', async t => {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
  });
  const budget = new MintBudget(Date.now() + 40);
  try { await assert.rejects(createMinter('WEB', 'google', budget), /mint_deadline/); assert.equal(aborted, true); }
  finally { budget.close(); }
});
test('actual mint pipeline validates page/minter, selects route, and uses fresh page state on retry',async t=>{
  const saved={fetch:globalThis.fetch,create:BotGuardClient.create,webCreate:WebPoMinter.create};
  const globals=['window','document','navigator','location','origin','yt','test_guard'];
  const descriptors=Object.fromEntries(globals.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{
    globalThis.fetch=saved.fetch;BotGuardClient.create=saved.create;WebPoMinter.create=saved.webCreate;
    for(const key of globals){const descriptor=descriptors[key];if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
  });
  let pages=0, event=true, client='WEB', suppliedMinter=true, embedded=true, rejectFirst=false;
  const routes=[], snapshots=[];
  globalThis.fetch=async (url,init)=>{
    assert.equal(init.redirect,'error');assert.ok(init.signal);
    if(url==='https://www.youtube.com/' || url==='https://www.youtube.com/tv'){
      pages++;
      const config={INNERTUBE_CONTEXT:{client:{clientName:client}},...(event?{EVENT_ID:`event${pages}`}:{})};
      const challenge={program:`program${pages}`,globalName:'test_guard',interpreterUrl:{privateDoNotAccessOrElseTrustedResourceUrlWrappedValue:'//www.google.com/js/bg/test.js'}};
      return new Response(`ytcfg.set( \n ${JSON.stringify(config)});${embedded?`window.ytAtN(${JSON.stringify({R:{bgChallenge:challenge}})});`:''}`);
    }
    if(url==='https://www.google.com/js/bg/test.js')return new Response('globalThis.test_guard = {};');
    if(url.includes('/att/get'))return Response.json({bgChallenge:{program:'tv',globalName:'test_guard',interpreterUrl:{privateDoNotAccessOrElseTrustedResourceUrlWrappedValue:'//www.google.com/js/bg/test.js'}}});
    routes.push(url);
    assert.equal(JSON.parse(init.body)[0],'O43z0dpjhgX20SCx4KAo');
    if(rejectFirst && routes.length===1)return Response.json(['',0]);
    return Response.json(['aW50ZWdyaXR5',3600,100,'']);
  };
  BotGuardClient.create=async options=>({async snapshot({webPoSignalOutput}){
    snapshots.push([options.program,globalThis.yt.config_.EVENT_ID]);
    if(suppliedMinter)webPoSignalOutput[0]=async()=>{};
    return 'snapshot';
  }, async shutdown(){}});
  WebPoMinter.create=async()=>({async mintAsWebsafeString(value){assert.equal(value,binding);return 'accepted_token'}});
  async function directly(route){const budget=new MintBudget();try{return await createMinter(client,route,budget)}finally{budget.close()}}
  event=false;await assert.rejects(directly('google'),/page_event_id_missing/);assert.equal(routes.length,0);
  event=true;suppliedMinter=false;await assert.rejects(directly('google'),/botguard_minter_missing/);assert.equal(routes.length,0);
  suppliedMinter=true;embedded=false;await assert.rejects(directly('google'),/botguard_challenge_missing/);assert.equal(routes.length,0);
  embedded=true;rejectFirst=true;
  const service=new TokenMinter('WEB','google');
  assert.equal((await service.mint(binding,false)).poToken,'accepted_token');
  assert.deepEqual(routes,['https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT','https://www.youtube.com/api/jnn/v1/GenerateIT']);
  assert.notEqual(snapshots.at(-1)[0],snapshots.at(-2)[0]);
  for(const [program,eventID] of snapshots)assert.equal(program.replace('program',''),eventID.replace('event',''));
  await service.dispose();
  client='TVHTML5';embedded=false;rejectFirst=false;
  const tv=await directly('youtube');await tv.close();
  assert.equal(routes.at(-1),'https://www.youtube.com/api/jnn/v1/GenerateIT');
});
