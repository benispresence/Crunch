import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE);
const apiBase = process.env.API_BASE || 'http://127.0.0.1:13691/api';
const frontend = process.env.FRONTEND_URL || 'http://127.0.0.1:15173';
let token;
async function api(path, body, method) {
  const res = await fetch(apiBase + path, {method: method || (body ? 'POST':'GET'),headers:{'content-type':'application/json',...(token ? {authorization:`Bearer ${token}`} : {})}, body:body ? JSON.stringify(body):undefined});
  const value = await res.json();
  assert.ok(res.ok, `${path}: ${JSON.stringify(value)}`);return value;
}
let auth;
if (process.env.TEST_JWT_SECRET) {
  assert.ok(apiBase.startsWith('http://127.0.0.1:'), 'Test JWT only for isolated loopback API');
  const jwt = (await import('jsonwebtoken')).default;
  auth = {token: jwt.sign({sub:1,email:'admin@nicemeta.local',role:'admin',tv:0},process.env.TEST_JWT_SECRET),user:{id:1,email:'admin@nicemeta.local',role:'admin'}};
} else {
  const cfg = await api('/auth/config');
  auth = await api('/auth/login',{email:cfg.default_admin_email || 'admin@nicemeta.local',password:cfg.default_admin_password || process.env.TEST_PASSWORD});
}
token = auth.token;
await api('/auth/keep-default-password',{});
const conn = await api('/connections',{name:'Release production',type:'sqlite',config:{database:':memory:'}});
const scratch = await api('/connections',{name:'Release scratch',type:'sqlite',config:{database:'/private/tmp/crunch-browser-scratch.sqlite'}});
const p = await api('/pipelines',{name:'Release browser pipeline', source_type:'custom',code_mode:'custom', python_code:"def run():\n    import time\n    time.sleep(2)\n    return {'rows_loaded': 20001}\n",extract_strategy:'full',write_behavior:'append',destination_connection_id:conn.id,destination_dataset:'raw',scratch_destination_connection_id:scratch.id,scratch_destination_dataset:'test_data',timezone:'Europe/Berlin'});
const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(({token,user})=>{localStorage.setItem('nm_token',token);localStorage.setItem('nm_user',JSON.stringify({...user,must_change_password:false}));},{token,user:auth.user});
try {
  await page.goto(frontend + '/pipelines/'+p.id);
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('v1'));
  await page.getByRole('button',{name:'Run published version',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.run-detail')?.textContent.includes('20001'),{},{timeout:60000});
  assert.match(await page.locator('.run-detail').innerText(), /success/);
  assert.equal(await page.getByText('Unsaved changes',{exact:true}).count(),0);
  await page.screenshot({path:'/private/tmp/crunch-v1.2-run.png',fullPage:true});
  await page.getByRole('button',{name:'Test draft',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.run-detail')?.textContent.includes('Draft test'),{},{timeout:15000});
  await page.waitForFunction(()=>document.querySelector('.run-detail')?.textContent.includes('success'),{},{timeout:60000});
  await api(`/pipelines/${p.id}`,{python_code:"def run():\n    import time\n    time.sleep(60)\n    return 1\n"},'PUT');
  const latest = await api(`/pipelines/${p.id}/publish`,{change_summary:'Long run for cancellation'});
  const versions = await api(`/pipelines/${p.id}/versions`);
  const first = versions.versions.find(v=>v.version_number===1);
  const diff = await api(`/pipelines/${p.id}/versions/${first.id}/diff/${latest.version_id}`);
  assert.equal(diff.code_diff.changed,true, 'custom Python edit must be saved without repeating code_mode');
  assert.match(diff.code_diff.after,/sleep\(60\)/);
  await page.reload();
  await page.getByRole('button',{name:'Run published version',exact:true}).click();
  await page.getByRole('button',{name:'Cancel run',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.run-detail')?.textContent.includes('cancelled'),{},{timeout:15000});
  await page.getByRole('button',{name:'Versions',exact:true}).click();
  await page.getByRole('button',{name:'Diff vs latest',exact:true}).first().click();
  await page.locator('.monaco-diff-editor').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('.monaco-diff-editor')?.textContent.includes('60'));
  await page.screenshot({path:'/private/tmp/crunch-v1.2-versions.png',fullPage:true});
  const publishedBefore=(await api(`/pipelines/${p.id}/versions`)).versions.length;
  await page.route(`**/api/pipelines/${p.id}`, async route => {
    if (route.request().method()==='PUT') return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Simulated save failure'})});
    return route.continue();
  });
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.locator('.detail__error').filter({ hasText: 'Simulated save failure' }).waitFor();
  assert.equal((await api(`/pipelines/${p.id}/versions`)).versions.length,publishedBefore,'Failed draft save must abort publish');
  await page.unroute(`**/api/pipelines/${p.id}`);

  await page.goto(frontend+'/pipelines');
  await page.getByRole('button',{name:'+ New pipeline',exact:true}).click();
  await page.locator('.pipes__create textarea').fill('Copy orders every hour');
  assert.equal(await page.getByRole('button',{name:'Create with AI',exact:true}).isEnabled(),true);
  await page.screenshot({path:'/private/tmp/crunch-v1.2-overview.png',fullPage:true});
  // Deterministic assistant transport fixture; actual proposal acceptance uses the API.
  await page.route('**/api/chat/send', async route => {
    assert.match(route.request().postData(), /Copy orders every hour/);
    const proposal={kind:'new_pipeline',pipeline:{name:'AI browser draft',source_type:'custom',source_config:{},load_mode:'append',extract_strategy:'full',write_behavior:'append',destination_connection_id:conn.id,destination_dataset:'raw',python_code:'def run():\n    return 1\n',code_mode:'custom',schedule:null,schedule_enabled:false}};
    const events=[['tool_call',{id:'create',name:'propose_new_pipeline',input:{name:'AI browser draft'}}],['tool_result',{id:'create',result:{success:true,proposal}}],['done',{}]];
    await route.fulfill({status:200,contentType:'text/event-stream',body:events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')});
  });
  await page.getByRole('button',{name:'Create with AI',exact:true}).click();
  await page.getByLabel('Proposal pipeline name').fill('AI browser edited draft');
  await page.getByRole('button',{name:'Accept',exact:true}).click();
  await page.getByText('✓ Applied',{exact:false}).waitFor();
  const overview=await api('/pipelines/overview');
  assert.ok(overview.pipelines.some(p=>p.name==='AI browser edited draft'));

  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',pipeline:p.id,checks:['publish','production run','live status','scratch test','cancel','version code diff','AI editable proposal acceptance (mocked assistant)'],screenshots:3}));
} finally {await browser.close();}
