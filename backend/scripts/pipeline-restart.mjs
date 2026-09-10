import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'crunch-restart-'));
const port=14691;
const base=`http://127.0.0.1:${port}/api`;
let child, token;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function start(){
 child=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',DATABASE_FILE:path.join(directory,'api.sqlite'),NICEMETA_WORKSPACE_DIR:path.join(directory,'workspace'),PYTHON_ENGINE_URL:'http://127.0.0.1:18765',PYTHON_ENGINE_TOKEN:'release-test-engine'},stdio:'ignore'});
}
async function request(p,body,method){const r=await fetch(base+p,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
async function ready(){for(let i=0;i<100;i++){try{await request('/health');return;}catch{}await wait(200);}throw new Error('API failed to start');}
try{
 start(); await ready();
 const cfg=await request('/auth/config');
 token=(await request('/auth/login',{email:cfg.default_admin_email,password:cfg.default_admin_password})).token;
 await request('/auth/keep-default-password',{});
 const destination=await request('/connections',{name:'restart target',type:'sqlite',config:{database:path.join(directory,'output.sqlite')}});
 const code="def run():\n    import time\n    from sqlalchemy import text\n    time.sleep(4)\n    with ctx.engine.begin() as conn:\n        conn.execute(text('CREATE TABLE IF NOT EXISTS writes (id INTEGER)'))\n        conn.execute(text('INSERT INTO writes VALUES (1)'))\n    return {'rows_loaded': 1}\n";
 const pipeline=await request('/pipelines',{name:'restart proof',source_type:'custom',code_mode:'custom',python_code:code,extract_strategy:'full',write_behavior:'append',destination_connection_id:destination.id,destination_dataset:'main'});
 await request(`/pipelines/${pipeline.id}/publish`,{});
 const run=await request(`/pipelines/${pipeline.id}/run`,{});
 await wait(1500);
 child.kill('SIGKILL'); await new Promise(r=>child.once('exit',r));
 start(); await ready();
 let result;
 for(let i=0;i<120;i++){result=await request(`/pipelines/${pipeline.id}/runs/${run.id}`);if(['success','failed'].includes(result.status))break;await wait(500);}
 assert.equal(result.status,'success',JSON.stringify(result));
 const Database=(await import('better-sqlite3')).default;
 const output=new Database(path.join(directory,'output.sqlite'));
 assert.equal(output.prepare('SELECT COUNT(*) AS n FROM writes').get().n,1);
 output.close();
 console.log('PASS: killed and restarted the API during a write job; recovered success and exactly one destination write');
}finally{child?.kill('SIGTERM');}
