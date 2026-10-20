#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BORUNA = process.env.BORUNA_BIN || 'boruna';
const ROOT = path.resolve(process.env.COMPOUNDING_WORKDIR || process.cwd());
const DATA = path.join(ROOT, '.boruna', 'swarm');
const POLICY = path.resolve(process.env.COMPOUNDING_POLICY || path.join(HERE, '..', 'policy.json'));
const WORKFLOWS = path.resolve(process.env.COMPOUNDING_WORKFLOWS || path.join(HERE, '..', 'workflows'));
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SHA_RE = /^[a-fA-F0-9]{7,64}$/;
let queue = Promise.resolve();
function serialize(fn) { const result = queue.then(fn, fn); queue = result.catch(() => {}); return result; }
function swarmDir(id) { if (!ID_RE.test(id)) throw new Error('swarm_id must be 1-64 letters, numbers, _ or -'); return path.join(DATA, id); }
function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function schema(properties, required = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const tools = [
  { name: 'swarm_init', description: 'Create a persistent swarm with a task spec and episode budget.', inputSchema: schema({ swarm_id:{type:'string'}, task:{type:'string'}, budget:{type:'integer',minimum:1,maximum:10000}, metric:{type:'string'}, direction:{type:'string',enum:['minimize','maximize']} }, ['swarm_id','task','budget','metric','direction']) },
  { name: 'swarm_status', description: 'Read state, in-flight workers, nominations, and best validated score. Votes are not correctness evidence.', inputSchema: schema({ swarm_id:{type:'string'} }, ['swarm_id']) },
  { name: 'swarm_announce', description: 'Publish worker scope, deliverable, success condition, and abort condition before editing.', inputSchema: schema({ swarm_id:{type:'string'}, worker:{type:'string'}, gap:{type:'string'}, deliverable:{type:'string'}, success:{type:'string'}, abort:{type:'string'} }, ['swarm_id','worker','gap','deliverable','success','abort']) },
  { name: 'swarm_commit', description: 'Record a validated contribution with parent and semantic informed_by SHAs.', inputSchema: schema({ swarm_id:{type:'string'}, worker:{type:'string'}, parent:{type:'string'}, informed_by:{type:'array',items:{type:'string'}}, message:{type:'string'}, score:{type:'number'}, validation:{type:'string'} }, ['swarm_id','worker','parent','informed_by','message','score','validation']) },
  { name: 'swarm_nominate', description: 'Nominate an existing candidate with a rationale. This records a vote, not a quality proof.', inputSchema: schema({ swarm_id:{type:'string'}, worker:{type:'string'}, candidate_sha:{type:'string'}, rationale:{type:'string'} }, ['swarm_id','worker','candidate_sha','rationale']) },
  { name: 'swarm_abstain', description: 'Release a worker slot without spending an episode, with a non-empty reason.', inputSchema: schema({ swarm_id:{type:'string'}, worker:{type:'string'}, reason:{type:'string'} }, ['swarm_id','worker','reason']) },
  { name: 'swarm_ancestry', description: 'Trace Git parents and informed_by dependencies from a candidate SHA in the configured repository.', inputSchema: schema({ swarm_id:{type:'string'}, candidate_sha:{type:'string'} }, ['swarm_id','candidate_sha']) },
];
async function runBoruna(workflow) {
  const dir = path.join(WORKFLOWS, workflow);
  const evidenceDir = path.join(DATA, '.evidence', workflow);
  await mkdir(evidenceDir, {recursive:true});
  const { stdout, stderr } = await execFileAsync(BORUNA, ['workflow','run',dir,'--policy',POLICY,'--live','--record','--evidence-dir',evidenceDir,'--data-dir',path.join(DATA,'.boruna-runs')], { cwd: ROOT, windowsHide: true, maxBuffer: 1024*1024 });
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/run_id:\s*([a-f0-9]+)/i);
  if (/run: Failed|Failed \(/.test(text)) throw new Error(`Boruna workflow ${workflow} failed: ${text.trim()}`);
  if (match) {
    const { stdout: detail } = await execFileAsync(BORUNA, ['workflow','show',match[1],'--json','--data-dir',path.join(DATA,'.boruna-runs')], { cwd: ROOT, windowsHide: true, maxBuffer: 1024*1024 });
    const run = JSON.parse(detail);
    const step = run.steps?.[0];
    if (step?.status !== 'completed' || step?.output_json_preview !== '{"Int":0}') throw new Error(`Boruna workflow ${workflow} rejected the operation (step output ${step?.output_json_preview ?? 'missing'})`);
  } else if (!/run: Completed/.test(text)) throw new Error(`Boruna workflow ${workflow} did not report completion: ${text.trim()}`);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
async function readJson(file, fallback = null) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}
function needString(v, name) { if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} must be a non-empty string`); return v.trim(); }
function validateProvenance(parent, sources) {
  needString(parent, 'parent');
  if (!Array.isArray(sources) || !sources.length || !sources.includes(parent)) throw new Error('informed_by must be a non-empty array that includes parent');
  for (const sha of sources) if (!SHA_RE.test(sha) && sha !== 'v0') throw new Error(`invalid informed_by SHA: ${sha}`);
}
async function borunaStaging(dir, payloads, run) {
  // Boruna workflows use a fixed staging directory. Calls are serialized so
  // concurrent clients cannot overwrite the staged input during execution.
  const stage = path.join(DATA, 'swarm-stage');
  await mkdir(stage, {recursive:true});
  await writeJson(path.join(stage,'state.json'), {swarm_id:'stage',budget:1,used:0,inflight:{},nominations:[],contributions:[],best_score:null,best_sha:null});
  const temps = [];
  for (const [name,value] of Object.entries(payloads)) {
    const file = path.join(stage,name);
    const previous = await readFile(file).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    temps.push([file,previous]);
    if (name.endsWith('.txt')) await writeFile(file,value,'utf8'); else await writeJson(file,value);
  }
  try { return await runBoruna(run); }
  finally {
    for (const [file,previous] of temps) {
      if (previous === null) await rm(file,{force:true}); else await writeFile(file,previous);
    }
    await rm(path.join(stage,'state.json'),{force:true});
  }
}
async function callTool(name, a) { return serialize(() => callToolSerial(name,a)); }
async function callToolSerial(name, a) {
  const id = needString(a.swarm_id, 'swarm_id'); const dir = swarmDir(id);
  if (name === 'swarm_init') {
    const existing=await readJson(path.join(dir,'state.json')); if(existing) throw new Error(`swarm ${id} already exists`);
    const budget=Number(a.budget); if(!Number.isInteger(budget)||budget<1||budget>10000) throw new Error('budget must be an integer from 1 to 10000');
    const direction=a.direction; if(!['minimize','maximize'].includes(direction)) throw new Error('direction must be minimize or maximize');
    await mkdir(dir,{recursive:true});
    const spec={task:needString(a.task,'task'),metric:needString(a.metric,'metric'),direction,created_at:new Date().toISOString()};
    const state={swarm_id:id,budget,used:0,inflight:{},nominations:[],contributions:[],best_score:null,best_sha:null,direction};
    await writeJson(path.join(dir,'spec.json'),spec); await writeJson(path.join(dir,'state.json'),state);
    await borunaStaging(dir,{},'swarm_init'); return jsonResult({success:true,swarm_id:id,state});
  }
  const state=await readJson(path.join(dir,'state.json')); if(!state) throw new Error(`swarm ${id} not found; call swarm_init first`);
  if(name==='swarm_status') { await borunaStaging(dir,{},'swarm_status'); return jsonResult({...state,note:'Nominations are coordination metadata, not correctness evidence.'}); }
  if(name==='swarm_announce') {
    const worker=needString(a.worker,'worker'); const record={gap:needString(a.gap,'gap'),deliverable:needString(a.deliverable,'deliverable'),success:needString(a.success,'success'),abort:needString(a.abort,'abort'),announced_at:new Date().toISOString()};
    state.inflight[worker]=record; await writeJson(path.join(dir,'state.json'),state);
    await borunaStaging(dir,{ 'announce.json':record,'worker.txt':worker },'swarm_announce'); return jsonResult({success:true,worker,record});
  }
  if(name==='swarm_commit') {
    const worker=needString(a.worker,'worker'), parent=needString(a.parent,'parent'); validateProvenance(parent,a.informed_by);
    const validation=needString(a.validation,'validation'); if(typeof a.score!=='number'||!Number.isFinite(a.score)) throw new Error('score must be finite');
    if(state.used>=state.budget) throw new Error('episode budget exhausted');
    const record={worker,parent,informed_by:[...new Set(a.informed_by)],message:needString(a.message,'message'),score:a.score,validation,committed_at:new Date().toISOString()};
    const index=state.contributions.length; await borunaStaging(dir,{'commit.json':record},'swarm_commit');
    await writeJson(path.join(dir,`commit-${index}.json`),record); state.contributions.push(record); state.used++;
    const better=state.best_score===null||(state.direction==='minimize'?a.score<state.best_score:a.score>state.best_score); if(better){state.best_score=a.score;state.best_sha=parent;}
    await writeJson(path.join(dir,'state.json'),state); return jsonResult({success:true,record,best_score:state.best_score,best_sha:state.best_sha});
  }
  if(name==='swarm_nominate') {
    const vote={worker:needString(a.worker,'worker'),candidate_sha:needString(a.candidate_sha,'candidate_sha'),rationale:needString(a.rationale,'rationale'),nominated_at:new Date().toISOString()};
    await borunaStaging(dir,{'nominate.json':vote},'swarm_nominate'); state.nominations.push(vote); await writeJson(path.join(dir,'state.json'),state); return jsonResult({success:true,vote,note:'Vote is not validation evidence.'});
  }
  if(name==='swarm_abstain') {
    const abstention={worker:needString(a.worker,'worker'),reason:needString(a.reason,'reason'),budget_consumed:false,abstained_at:new Date().toISOString()};
    await borunaStaging(dir,{'abstain.json':abstention},'swarm_abstain'); delete state.inflight[abstention.worker]; await writeJson(path.join(dir,'state.json'),state); return jsonResult({success:true,abstention});
  }
  if(name==='swarm_ancestry') {
    const sha=needString(a.candidate_sha,'candidate_sha'); if(!SHA_RE.test(sha)) throw new Error('candidate_sha must be a Git SHA');
    const {stdout}=await execFileAsync('git',['log','--format=%H%x09%P%x09%s','--all','--max-count=1000'],{cwd:ROOT,windowsHide:true,maxBuffer:4*1024*1024});
    const map=new Map(stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>{const [h,p,...s]=line.split('\t');return[h,{sha:h,parents:p?p.split(' '):[],subject:s.join('\t')}]}));
    if(!map.has(sha)) throw new Error(`candidate ${sha} not found in git history`);
    const seen=new Set(),stack=[sha];while(stack.length){const cur=stack.pop();if(seen.has(cur))continue;seen.add(cur);for(const p of map.get(cur)?.parents||[])stack.push(p);}
    await borunaStaging(dir,{'query.json':{candidate_sha:sha}},'swarm_ancestry'); return jsonResult({candidate_sha:sha,git_parent_ancestry:[...seen],records:[...seen].map(s=>map.get(s)).filter(Boolean)});
  }
  throw new Error(`unknown tool: ${name}`);
}
const server=new Server({name:'compounding-mcp',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async(req)=>{try{return await callTool(req.params.name,req.params.arguments||{});}catch(e){return{isError:true,content:[{type:'text',text:e.message||String(e)}]};}});
await server.connect(new StdioServerTransport());
