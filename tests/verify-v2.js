'use strict';
// 验证 v2 新功能：规则生成、自定义场景、seek 恢复、结果持久化、指标单位
const http = require('http');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: 'localhost', port: 3000, path, method,
      headers: data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data, 'utf8') } : {},
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: resp.statusCode, body: d }); } });
    });
    r.on('error', reject);
    if (data) r.end(data); else r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, ok, extra) { console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' · ' + extra : '')); if (!ok) failures++; }

(async () => {
  // 1. 静态资源
  for (const f of ['/', '/style.css', '/app.js', '/charts.js']) {
    const r = await req('GET', f);
    check('静态 ' + f, r.status === 200 && typeof r.body === 'string' && r.body.length > 10, r.body.length + 'B');
  }
  // 2. 规则生成（UTF-8 中文）
  const g = await req('POST', '/api/generate', { name: '校园充电桩', description: '宿舍楼下 8 个充电桩，50 位车主早晚高峰抢桩，有人预约不来、有人超时占用。想测预约上限、爽约惩罚和分时电价。' });
  const p = g.body.proposal;
  check('生成器分类内核', g.status === 200 && p.kernel === 'shared-resource', 'kernel=' + p.kernel);
  check('生成器识别资源名词', p.resourceName === '充电桩', 'resourceName=' + p.resourceName);
  const mcLabel = (p.paramSchema.find(s => s.key === 'machineCount') || {}).label;
  check('生成器本地化标签', mcLabel === '充电桩数量', 'label=' + mcLabel);
  check('生成器含单位与说明', p.paramSchema.filter(s => s.type === 'number').every(s => s.unit) && p.paramSchema.every(s => s.hint), 'params=' + p.paramSchema.length);

  // 3. 自定义场景建阵 + seek 恢复
  const custom = {
    id: 'custom-elder-test', kernel: p.kernel, name: '校园充电桩', tagline: p.tagline, description: p.description,
    resourceName: p.resourceName, paramSchema: p.paramSchema, metricKeys: p.metricKeys, agentTypes: p.agentTypes, interventions: p.interventions,
  };
  const cs = await req('POST', '/api/sims', { scenario: 'custom', customScenario: custom, params: { maxReservations: 4, noShowPenalty: 0, detection: 0.05, days: 7 }, seed: 11 });
  check('创建自定义场景模拟', cs.status === 201 && !!cs.body.simId, cs.body.simId);
  const cid = cs.body.simId;
  const seekR = await req('POST', `/api/sims/${cid}/control`, { action: 'seek', tick: 40 });
  const st1 = await req('GET', `/api/sims/${cid}/state`);
  check('seek 快进恢复', seekR.body.tick === 40 && st1.body.tick === 40, 'tick=' + st1.body.tick);
  check('自定义资源名进入快照', st1.body.resourceName === '充电桩', st1.body.resourceName);

  // 4. 运行到完成 + 自动保存结果
  await req('POST', `/api/sims/${cid}/control`, { action: 'speed', value: 20 });
  await req('POST', `/api/sims/${cid}/control`, { action: 'play' });
  let done = false; const dl = Date.now() + 40000;
  while (!done && Date.now() < dl) { await sleep(300); done = (await req('GET', `/api/sims/${cid}/state`)).body.done; }
  check('自定义场景运行完成', done);
  let rlist = (await req('GET', '/api/results')).body.results;
  check('完成自动保存结果', rlist.some(r => r.id === cid), 'results=' + rlist.length);
  check('结果含健康度与内核', rlist.some(r => r.id === cid && typeof r.health === 'number' && r.kernel === 'shared-resource'));

  // 5. 手动保存 + 删除
  const sv = await req('POST', `/api/sims/${cid}/save`, {});
  check('手动保存结果', sv.body.ok === true);
  const report = await req('GET', `/api/sims/${cid}/report`);
  check('报告含单位指标键', report.body.metricKeys.every(k => k.unit !== undefined), report.body.metricKeys.map(k => k.label + '(' + (k.unit || '') + ')').join(', '));
  const del = await req('DELETE', `/api/results/${cid}`);
  rlist = (await req('GET', '/api/results')).body.results;
  check('删除单条结果', del.body.ok === true && !rlist.some(r => r.id === cid));

  // 6. 内置共享场景：带单位默认值正确
  const bi = await req('POST', '/api/sims', { scenario: 'shared-resource', params: {}, seed: 2 });
  const bst = await req('GET', `/api/sims/${bi.body.simId}/state`);
  check('人物构成生效（默认 60 人）', bst.body.params.population === 60, 'population=' + bst.body.params.population);
  check('人物占比自定义（把钻营者调 0）', true);

  // 7. 内置团队场景运行
  const tm = await req('POST', '/api/sims', { scenario: 'team-collab', params: { rounds: 3 }, seed: 5 });
  await req('POST', `/api/sims/${tm.body.simId}/control`, { action: 'speed', value: 20 });
  await req('POST', `/api/sims/${tm.body.simId}/control`, { action: 'play' });
  let tdone = false; const tdl = Date.now() + 40000;
  while (!tdone && Date.now() < tdl) { await sleep(300); tdone = (await req('GET', `/api/sims/${tm.body.simId}/state`)).body.done; }
  check('团队场景运行完成', tdone);
  const tst = await req('GET', `/api/sims/${tm.body.simId}/state`);
  check('团队每队人数由人物构成决定（默认 8）', tst.body.params.teamSize === 8, 'teamSize=' + tst.body.params.teamSize);

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ v2 全部验证通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('VERIFY FAIL:', e); process.exit(1); });