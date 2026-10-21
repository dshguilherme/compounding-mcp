import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sdkRoots = [path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'compounding-mcp'), path.resolve('node_modules/compounding-mcp')];
const { Client } = require(require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: sdkRoots }));
const { StdioClientTransport } = require(require.resolve('@modelcontextprotocol/sdk/client/stdio.js', { paths: sdkRoots }));

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const globalPkg = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'compounding-mcp', 'src', 'server.js');
const boruna = process.env.BORUNA_BIN || 'boruna';
const run = spawnSync('python', ['-m', 'unittest', 'discover', '-s', 'examples/tiny-cg', '-v'], { cwd: repoRoot, encoding: 'utf8' });
if (run.status !== 0) throw new Error(`Numerical tests failed:\n${run.stdout}\n${run.stderr}`);
const demo = spawnSync('python', ['examples/tiny-cg/cg_demo.py'], { cwd: repoRoot, encoding: 'utf8' });
if (demo.status !== 0) throw new Error(`CG demo failed:\n${demo.stderr}`);
const residual = Number(demo.stdout.match(/residual_l2=([\deE+.-]+)/)?.[1]);
if (!Number.isFinite(residual)) throw new Error(`Could not parse residual from:\n${demo.stdout}`);
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
if (head.status !== 0) throw new Error(`Could not read Git HEAD:\n${head.stderr}`);
const sha = head.stdout.trim();
const env = { ...process.env, COMPOUNDING_WORKDIR: repoRoot, BORUNA_BIN: boruna };
const transport = new StdioClientTransport({ command: process.execPath, args: [globalPkg], cwd: repoRoot, env });
const client = new Client({ name: 'tiny-cg-smoke-test', version: '0.1.0' }, { capabilities: {} });
const result = [];
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.map(c => c.text).join('\n')}`);
  const value = JSON.parse(r.content[0].text);
  result.push({ tool: name, result: value });
  return value;
}
try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (listed.tools.length !== 7) throw new Error(`Expected seven tools; found ${listed.tools.length}`);
  const swarm_id = `tiny-cg-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  await call('swarm_init', { swarm_id, task: 'Validate a baseline conjugate-gradient solve and record its measured residual', budget: 5, metric: 'residual_l2', direction: 'minimize' });
  await call('swarm_status', { swarm_id });
  await call('swarm_announce', { swarm_id, worker: 'baseline', gap: 'No measured baseline in this swarm', deliverable: 'Run the known-solution CG example and tests', success: 'residual_l2 < 1e-12 and solution error < 1e-12', abort: 'A verified baseline already exists' });
  await call('swarm_commit', { swarm_id, worker: 'baseline', parent: sha, informed_by: [sha], message: 'Record the tested tiny CG baseline', score: residual, validation: `python -m unittest discover -s examples/tiny-cg -v passed (2 tests); ${demo.stdout.trim().replaceAll('\n', '; ')}` });
  await call('swarm_nominate', { swarm_id, worker: 'reviewer', candidate_sha: sha, rationale: `Baseline passes the known-solution test with residual ${residual}` });
  await call('swarm_abstain', { swarm_id, worker: 'duplicate-check', reason: 'This smoke test has no independent improvement candidate to publish' });
  const status = await call('swarm_status', { swarm_id });
  if (status.used !== 1 || status.contributions.length !== 1 || status.nominations.length !== 1 || status.best_score !== residual) throw new Error(`Unexpected final state: ${JSON.stringify(status)}`);
  await call('swarm_ancestry', { swarm_id, candidate_sha: sha });
  console.log(JSON.stringify({ success: true, installed_server: globalPkg, tools: listed.tools.map(t => t.name), residual_l2: residual, git_head: sha, calls: result }, null, 2));
} finally {
  await client.close();
}
