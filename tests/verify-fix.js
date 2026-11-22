'use strict';
// 验证：报告携带 scenarioDef，据此重建自定义场景，使「应用修复并重跑（同种子）」不再报未知场景
const http = require('http');
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: 'localhost', port: 3000, path, method,
      headers: data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data, 'utf8') } : {},
    }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: resp.statusCode, body: d }); } });
    });
    r.on('error', reject); if (data) r.end(data); else r.end();
  });
}
let failures = 0;
const check = (n, ok, x) => { console.log((ok ? '✅' : '❌') + ' ' + n + (x ? ' · ' + x : '')); if (!ok) failures++; };

(async () => {
  // —— 自定义场景路径 ——
  const g = await req('POST', '/api/generate', { name: '校园充电桩', description: '宿舍楼下 8 个充电桩，50 位车主早晚高峰抢桩，有人预约不来、有人超时。想测预约上限、爽约惩罚、分时电价。' });
  const p = g.body.proposal;
  const cs = { id: 'custom-applyfix-test', kernel: p.kernel, name: p.name, tagline: p.tagline, description: p.description, resourceName: p.resourceName, paramSchema: p.paramSchema, metricKeys: p.metricKeys, agentTypes: p.agentTypes, interventions: p.interventions };
  const c1 = await req('POST', '/api/sims', { scenario: 'custom', customScenario: cs, params: {}, seed: 7 });
  check('创建自定义模拟', c1.status === 201, c1.body.simId);
  const rep = await req('GET', `/api/sims/${c1.body.simId}/report`);
  check('报告含 scenarioDef', rep.status === 200 && rep.body.scenarioDef && typeof rep.body.scenarioDef.kernel === 'string');
  check('scenarioDef.builtin=false', rep.body.scenarioDef && rep.body.scenarioDef.builtin === false, String(rep.body.scenarioDef && rep.body.scenarioDef.builtin));

  // 模拟 applyFix：重建 params（取报告里的值 + 修复项），按 scenarioDef 重新 POST
  const sd = rep.body.scenarioDef;
  const params = {}; for (const [k, v] of Object.entries(rep.body.params)) params[k] = v.value; params.noShowPenalty = 50;
  const payload = { params, seed: rep.body.seed, scenario: 'custom', customScenario: { id: sd.id, kernel: sd.kernel, name: sd.name, tagline: sd.tagline, description: sd.description, resourceName: sd.resourceName, paramSchema: sd.paramSchema, metricKeys: sd.metricKeys, agentTypes: sd.agentTypes, interventions: sd.interventions } };
  const c2 = await req('POST', '/api/sims', payload);
  check('自定义场景「应用修复并重跑」成功', c2.status === 201, 'new sim ' + (c2.body.simId || c2.body.error));
  if (c2.status === 201) {
    const st2 = await req('GET', `/api/sims/${c2.body.simId}/state`);
    check('重跑后参数生效（noShowPenalty=50）', st2.body.params.noShowPenalty === 50, 'noShowPenalty=' + st2.body.params.noShowPenalty);
    check('重跑后资源名词保留', st2.body.resourceName === '充电桩', st2.body.resourceName);
  }

  // —— 内置场景路径 ——
  const b1 = await req('POST', '/api/sims', { scenario: 'shared-resource', params: {}, seed: 9 });
  const brep = await req('GET', `/api/sims/${b1.body.simId}/report`);
  check('内置报告 scenarioDef.builtin=true', brep.body.scenarioDef && brep.body.scenarioDef.builtin === true);
  const bparams = {}; for (const [k, v] of Object.entries(brep.body.params)) bparams[k] = v.value; bparams.maxReservations = 1;
  const b2 = await req('POST', '/api/sims', { scenario: brep.body.scenarioId, params: bparams, seed: brep.body.seed });
  check('内置场景「应用修复并重跑」成功', b2.status === 201);

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 修复验证全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });