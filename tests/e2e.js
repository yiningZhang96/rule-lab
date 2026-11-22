'use strict';
// 端到端测试：通过 HTTP API 走完整流程（创建→实时改参→干预→SSE→扫描→报告→对比→修复重跑）
const http = require('http');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: 'localhost', port: 3000, path, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: d ? JSON.parse(d) : null }); }
        catch (e) { resolve({ status: resp.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (name, ok, extra) => {
    console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' · ' + extra : ''));
    if (!ok) failures++;
  };

  // 1. 创建团队模拟
  const created = await req('POST', '/api/sims', { scenario: 'team-collab', seed: 3, params: { rounds: 2 } });
  check('创建模拟', created.status === 201 && !!created.body.simId, created.body.simId || '');
  const simId = created.body.simId;

  // 2. 实时改参 + 干预
  const ps = await req('POST', `/api/sims/${simId}/params`, { updates: { auditChance: 0.5 } });
  check('实时改参', ps.status === 200 && ps.body.applied.includes('auditChance'));
  const iv = await req('POST', `/api/sims/${simId}/intervene`, { action: 'auditSurge' });
  check('外部干预', iv.status === 200);

  // 3. SSE 流：验证 tick 事件携带数据且 seq 单调
  await req('POST', `/api/sims/${simId}/control`, { action: 'speed', value: 20 });
  await req('POST', `/api/sims/${simId}/control`, { action: 'play' });
  const sse = await new Promise(resolve => {
    let buf = '', ticks = 0, withData = 0, lastSeq = 0, seqOk = true, hello = false;
    const r = http.get({ host: 'localhost', port: 3000, path: `/api/sims/${simId}/stream` }, res => {
      res.on('data', c => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.includes('event: hello')) hello = true;
          if (block.startsWith('event: tick') || block.includes('\nevent: tick')) {
            ticks++;
            const line = block.split('\n').find(l => l.startsWith('data: '));
            if (line) {
              withData++;
              try {
                const snap = JSON.parse(line.slice(6));
                const evs = snap.events || [];
                // 不变量1：快照内事件 seq 严格递增
                for (let k = 1; k < evs.length; k++) if (evs[k].seq <= evs[k - 1].seq) seqOk = false;
                // 不变量2：跨快照最大 seq 单调不减（尾部保留机制下旧事件会重复出现，属正常）
                if (evs.length && Math.max(...evs.map(e => e.seq)) < lastSeq) seqOk = false;
                if (evs.length) lastSeq = Math.max(lastSeq, ...evs.map(e => e.seq));
              } catch (e) { withData--; }
            }
          }
        }
        if (ticks >= 10) { r.destroy(); resolve({ hello, ticks, withData, seqOk }); }
      });
    });
    setTimeout(() => { r.destroy(); resolve({ hello, ticks, withData, seqOk, timeout: true }); }, 9000);
  });
  check('SSE hello 事件', sse.hello);
  check('SSE tick 事件携带快照数据', sse.ticks > 0 && sse.withData === sse.ticks, `${sse.withData}/${sse.ticks}`);
  check('事件 seq 单调递增（前端增量日志去重基础）', sse.seqOk);

  // 4. 等待运行结束
  let st;
  const deadline = Date.now() + 30000;
  do { await sleep(400); st = (await req('GET', `/api/sims/${simId}/state`)).body; } while (!st.done && Date.now() < deadline);
  check('模拟运行完成', st.done, `tick=${st.tick}`);
  check('state 端点返回扩展事件日志', st.events.length > 20, `${st.events.length} 条`);

  // 5. 规则修改记录可追溯
  check('规则修改记录包含实时改参', st.ruleLog.some(r => r.text.includes('申报审计概率')));

  // 6. 红队扫描 + 报告
  const scan = await req('POST', `/api/sims/${simId}/scan`, {});
  check('红队扫描接口', scan.status === 200 && typeof scan.body.found === 'number', `found=${scan.body.found}`);
  const rep = await req('GET', `/api/sims/${simId}/report`);
  check('漏洞报告生成', rep.status === 200 && Array.isArray(rep.body.vulnerabilities));
  check('报告含健康度与种子', typeof rep.body.health === 'number' && rep.body.seed === 3);
  const v0 = rep.body.vulnerabilities[0];
  if (v0) {
    check('漏洞含触发规则/证据/修复建议', !!(v0.trigger && v0.evidence && v0.fix && v0.fix.key), `${v0.name} · 证据${v0.evidence.length}条`);
  }

  // 7. A/B 对比（先建基线：同场景另一 sim）
  const base = await req('POST', '/api/sims', { scenario: 'team-collab', seed: 3, params: { rounds: 2 } });
  await req('POST', `/api/sims/${base.body.simId}/control`, { action: 'speed', value: 20 });
  await req('POST', `/api/sims/${base.body.simId}/control`, { action: 'play' });
  let bdone = false; const dl = Date.now() + 30000;
  do { await sleep(400); bdone = (await req('GET', `/api/sims/${base.body.simId}/state`)).body.done; } while (!bdone && Date.now() < dl);
  const cmp = await req('GET', `/api/sims/${simId}/compare?with=${base.body.simId}`);
  check('A/B 对比', cmp.status === 200 && cmp.body.available && cmp.body.rows.length > 0,
    cmp.body.available ? `${cmp.body.rows.length} 项指标` : '无基线');

  // 8. 修复重跑（同种子）
  const fixed = await req('POST', '/api/sims', { scenario: 'team-collab', seed: 3, params: { rounds: 2, scoring: 'hybrid', auditChance: 0.5 } });
  check('应用修复并重跑（同种子）', fixed.status === 201 && !!fixed.body.simId);

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 端到端全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('E2E FAIL:', e); process.exit(1); });
