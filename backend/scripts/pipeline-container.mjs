import assert from 'node:assert/strict';
const base=process.env.API_BASE || 'http://127.0.0.1:13693/api';
let token;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
for(let i=0;i<100;i++){try{await api('/health');break;}catch{} await wait(500);}
const cfg=await api('/auth/config');
token=(await api('/auth/login',{email:cfg.default_admin_email,password:cfg.default_admin_password})).token;
await api('/auth/keep-default-password',{});
const conn=await api('/connections',{name:'container target',type:'duckdb',config:{database:'/tmp/container-output.duckdb'}});
const p=await api('/pipelines',{name:'Container pipeline',source_type:'custom',code_mode:'custom',python_code:"def run():\n    import duckdb\n    conn = duckdb.connect(ctx.destination_config['database'])\n    conn.execute('CREATE TABLE IF NOT EXISTS loaded AS SELECT 123 AS id')\n    conn.close()\n    return {'rows_loaded': 1}\n",extract_strategy:'full',write_behavior:'append',destination_connection_id:conn.id,destination_dataset:'raw'});
await api(`/pipelines/${p.id}/publish`,{});
const run=await api(`/pipelines/${p.id}/run`,{});
let done;
for(let i=0;i<120;i++){done=await api(`/pipelines/${p.id}/runs/${run.id}`);if(['failed','success'].includes(done.status))break;await wait(500);}
assert.equal(done.status,'success',JSON.stringify(done));
assert.equal(done.rows_loaded,1);
console.log('PASS: backend container submitted a versioned job and the separate engine container executed it');
