import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const serverPath=fileURLToPath(new URL('../src/server.js',import.meta.url));
const repoRoot=fileURLToPath(new URL('../',import.meta.url));
async function start(){
 const workdir=await mkdtemp(path.join(os.tmpdir(),'compounding-mcp-test-'));
 const child=spawn(process.execPath,[serverPath],{stdio:['pipe','pipe','pipe'],env:{...process.env,COMPOUNDING_WORKDIR:workdir,BORUNA_BIN:process.env.BORUNA_BIN||'boruna',COMPOUNDING_WORKFLOWS:path.join(repoRoot,'workflows'),COMPOUNDING_POLICY:path.join(repoRoot,'policy.json')}});
 let buf=Buffer.alloc(0),stderr='',seq=0;const pending=[];child.on('error',e=>pending.forEach(p=>p.reject(e)));child.stderr.on('data',x=>stderr+=x.toString());
 child.stdout.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);while(true){const i=buf.indexOf('\n');if(i<0)break;const line=buf.subarray(0,i).toString();buf=buf.subarray(i+1);try{const m=JSON.parse(line),k=pending.findIndex(p=>p.id===m.id);if(k>=0)pending.splice(k,1)[0].resolve(m)}catch{}}});
 async function request(method,params={}){const id=++seq,p=new Promise((resolve,reject)=>pending.push({id,resolve,reject}));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return Promise.race([p,delay(10000).then(()=>{throw Error(`timeout ${method}: ${stderr}`)})])}
 await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
 return{workdir,child,request,close:async()=>{child.kill();await rm(workdir,{recursive:true,force:true})}};
}
const call=(s,name,args)=>s.request('tools/call',{name,arguments:args});
const body=r=>{const text=r.result.content[0].text;try{return JSON.parse(text)}catch{throw Error(text)}};
test('lists seven tools and rejects path traversal',async()=>{const s=await start();try{const r=await s.request('tools/list');assert.equal(r.result.tools.length,7);const bad=await call(s,'swarm_init',{swarm_id:'../oops',task:'t',budget:2,metric:'residual',direction:'minimize'});assert.equal(bad.result.isError,true);assert.match(bad.result.content[0].text,/swarm_id/)}finally{await s.close()}});
test('init, announce, commit, nomination, abstain and status persist through Boruna gates',async()=>{const s=await start();try{
 const init=await call(s,'swarm_init',{swarm_id:'test',task:'CG solver kernel',budget:10,metric:'residual',direction:'minimize'});assert.equal(body(init).success,true);
 const ann=await call(s,'swarm_announce',{swarm_id:'test',worker:'w1',gap:'preconditioner',deliverable:'new preconditioner',success:'residual < 1e-8',abort:'same approach exists'});assert.equal(body(ann).success,true);
 const commit=await call(s,'swarm_commit',{swarm_id:'test',worker:'w1',parent:'abcdef1234567',informed_by:['abcdef1234567'],message:'preconditioner update',score:1e-9,validation:'benchmark passed'});assert.equal(body(commit).success,true);
 const vote=await call(s,'swarm_nominate',{swarm_id:'test',worker:'w2',candidate_sha:'abcdef1234567',rationale:'lowest residual'});assert.equal(body(vote).success,true);
 const abstain=await call(s,'swarm_abstain',{swarm_id:'test',worker:'w3',reason:'all open gaps are covered'});assert.equal(body(abstain).abstention.budget_consumed,false);
 const status=await call(s,'swarm_status',{swarm_id:'test'});assert.equal(body(status).used,1);assert.equal(body(status).best_score,1e-9);assert.equal(body(status).nominations.length,1);
 const bad=await call(s,'swarm_commit',{swarm_id:'test',worker:'w4',parent:'bad',informed_by:[],message:'x',score:2,validation:'not run'});assert.equal(bad.result.isError,true);
 }finally{await s.close()}});
