// Run only against a disposable local database.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE);
const base = process.env.API_BASE || 'http://127.0.0.1:13694/api';
const frontend = process.env.FRONTEND_URL || 'http://127.0.0.1:15175';
assert.ok(base.startsWith('http://127.0.0.1:'));
const user = {id:1,email:'admin@nicemeta.local',role:'admin',must_change_password:false};
const token = jwt.sign({sub:1,email:user.email,role:user.role,tv:0},process.env.TEST_JWT_SECRET);
async function api(path, body, method) {
 const r = await fetch(base+path,{method:method || (body?'POST':'GET'),headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});
 const value = await r.json(); assert.ok(r.ok,JSON.stringify(value));return value;
}
await api('/auth/keep-default-password',{});
const conn = await api('/connections',{name:'Environment test',type:'sqlite',config:{database:':memory:'}});
const p = await api('/pipelines',{name:'Environment browser test',source_type:'custom',code_mode:'custom',destination_connection_id:conn.id,python_code:"def run():\n    assert ctx.env['REGION'] == 'eu'\n    assert len(ctx.env['API_TOKEN']) > 5\n    print(ctx.env['API_TOKEN'])\n    return {'rows_loaded': 3}\n"});
const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE});
const page = await browser.newPage({viewport:{width:1440,height:1100}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(({token,user})=>{localStorage.setItem('nm_token',token);localStorage.setItem('nm_user',JSON.stringify(user));},{token,user});
try {
 await page.goto(frontend+'/pipelines/'+p.id);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const panel=page.getByRole('region',{name:'Variables and secrets'});
 await panel.getByRole('button',{name:'Add variable',exact:true}).click();
 await panel.getByLabel('Variable name 1',{exact:true}).fill('REGION');
 await panel.getByLabel('Variable value 1',{exact:true}).fill('eu');
 await panel.getByRole('button',{name:'Add secret',exact:true}).click();
 await panel.getByLabel('Variable name 2',{exact:true}).fill('API_TOKEN');
 await panel.getByLabel('Variable value 2',{exact:true}).fill('browser-token-123');
 const save=async()=>{await panel.getByRole('button',{name:'Save variables & secrets',exact:true}).click();await panel.getByRole('status').waitFor();};
 await save();
 assert.equal(await panel.getByLabel('Variable value 2',{exact:true}).inputValue(),'');
 await save(); // preserve a masked existing secret
 await panel.getByLabel('Variable value 2',{exact:true}).fill('browser-token-456');
 await save();
 const env=await api(`/pipelines/${p.id}/environment`);assert.equal(env.entries[1].value,null);
 await api(`/pipelines/${p.id}/publish`,{});
 const run=await api(`/pipelines/${p.id}/run?wait=1`,{});
 assert.equal(run.status,'success',JSON.stringify(run));
 const detail=await api(`/pipelines/${p.id}/runs/${run.id}`);
 assert.ok(!JSON.stringify(detail).includes('browser-token-456'));
 assert.ok(JSON.stringify(detail).includes('[REDACTED]'));
 assert.ok(!JSON.stringify(await api(`/pipelines/${p.id}/versions`)).includes('browser-token'));
 await panel.screenshot({path:'/private/tmp/crunch-pipeline-environment.png'});
 await panel.getByRole('button',{name:'Remove',exact:true}).last().click();await save();
 assert.equal((await api(`/pipelines/${p.id}/environment`)).entries.length,1);
 assert.equal((await fetch(base+`/pipelines/${p.id}/environment`)).status,401);
 assert.equal((await fetch(base+`/pipelines/${p.id}/environment`,{headers:{authorization:`Bearer ${jwt.sign({sub:999,email:'other@local',role:'admin',tv:0},process.env.TEST_JWT_SECRET)}`}})).status,401);
 assert.deepEqual(errors,[]);
 console.log('PASS: browser add/preserve/rotate/delete, real engine execution, masked logs/API/versions, authentication');
} finally {await browser.close();}
