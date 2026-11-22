'use strict';
// 无头测试：运行两个场景（默认规则 + 宽松漏洞规则），验证模拟与红队检测
const { Simulation } = require('../src/engine');
const { SCENARIOS } = require('../src/scenarios');
const redteam = require('../src/redteam');

function run(scId, params, seed) {
  const sim = new Simulation(SCENARIOS[scId], params, seed);
  let guard = 0;
  while (!sim.done && guard++ < 200000) sim.step();
  return sim;
}
function line(s) { console.log(s); }
let failures = 0;

// ---- 场景 1：共享资源 ----
line('=== 共享资源实验室 · 默认规则 ===');
const s1 = run('shared-resource', {}, 20261121);
line(JSON.stringify(s1.latestMetrics()));
const r1 = redteam.buildReport({ id: 't1', sim: s1 });
line('漏洞: ' + (r1.vulnerabilities.map(v => `${v.name}(${v.severity})`).join(', ') || '无'));

line('\n=== 共享资源实验室 · 宽松漏洞规则（高预约上限/零惩罚/低监管） ===');
const s2 = run('shared-resource', {
  maxReservations: 5, noShowPenalty: 0, overrunPenalty: 0, detection: 0.05,
  leadSlots: 16, population: 80, machineCount: 5, queueMode: 'fcfs', days: 14,
}, 7);
line(JSON.stringify(s2.latestMetrics()));
const r2 = redteam.buildReport({ id: 't2', sim: s2 });
line('漏洞: ' + (r2.vulnerabilities.map(v => `${v.name}(${v.severity})`).join(', ') || '无'));
if (r2.vulnerabilities.length < 2) { line('!! 预期宽松规则下应检出 >=2 个漏洞'); failures++; }

// ---- 场景 2：团队协作 ----
line('\n=== 团队协作实验室 · 默认规则 ===');
const t1 = run('team-collab', {}, 20261121);
line(JSON.stringify(t1.latestMetrics()));
const tr1 = redteam.buildReport({ id: 't3', sim: t1 });
line('漏洞: ' + (tr1.vulnerabilities.map(v => `${v.name}(${v.severity})`).join(', ') || '无'));

line('\n=== 团队协作实验室 · 宽松漏洞规则（自我申报/低审计/平均奖励） ===');
const t2 = run('team-collab', {
  scoring: 'selfReport', auditChance: 0.05, rewardModel: 'equal',
  assignment: 'self', detection: 0.05, penalty: 0, difficultyBonus: 1.0, invisibleWeight: 0.3,
}, 99);
line(JSON.stringify(t2.latestMetrics()));
const tr2 = redteam.buildReport({ id: 't4', sim: t2 });
line('漏洞: ' + (tr2.vulnerabilities.map(v => `${v.name}(${v.severity})`).join(', ') || '无'));
if (tr2.vulnerabilities.length < 2) { line('!! 预期宽松规则下应检出 >=2 个漏洞'); failures++; }

// ---- 可复现性 ----
const a = run('shared-resource', {}, 42), b = run('shared-resource', {}, 42);
const repro = JSON.stringify(a.latestMetrics()) === JSON.stringify(b.latestMetrics());
line('\n可复现性（同种子同规则）: ' + (repro ? 'PASS' : 'FAIL'));
if (!repro) failures++;

// ---- 事件追溯完整性 ----
const evOk = s2.events.length > 50 && t2.events.length > 10;
line('事件日志追溯: ' + (evOk ? `PASS (shared=${s2.events.length}, team=${t2.events.length})` : 'FAIL'));
if (!evOk) failures++;

line('\n' + (failures ? `❌ ${failures} 项检查失败` : '✅ 全部检查通过'));
process.exit(failures ? 1 : 0);
