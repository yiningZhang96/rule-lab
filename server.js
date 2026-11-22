'use strict';
// RULE LAB 服务器：零依赖 Node 原生 HTTP
// - 静态文件服务
// - REST API（创建/控制模拟、改规则、干预、报告、A/B 对比）
// - SSE 实时流（tick 级推送）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Simulation } = require('./src/engine');
const { SCENARIOS, scenarioMeta } = require('./src/scenarios');
const redteam = require('./src/redteam');
const { generate: generateScenario } = require('./src/generator');

const PORT = +(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

const sims = new Map();          // simId -> rec
const lastByScenario = new Map();   // scenarioId -> 最近 simId
const lastCompleted = new Map();    // scenarioId -> 最近完成的 simId

// 持久化目录：云平台可挂载持久卷并通过 DATA_DIR 指向（如 /var/data），本地默认 ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
function loadResults() { try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch (e) { return []; } }
let results = loadResults();
function persistResults() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(RESULTS_FILE, JSON.stringify(results)); } catch (e) { console.error('[results]', e.message); } }

function uid() { return 'sim-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '', n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > 1e6) { reject(new Error('请求体过大')); req.destroy(); return; }
      d += c;
    });
    req.on('end', () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 以内置 kernel 为引擎，套用用户自定义的名称/标签/单位/默认值
function buildCustomScenario(c) {
  const kernel = SCENARIOS[c.kernel];
  if (!kernel) return null;
  const schema = (c.paramSchema && c.paramSchema.length) ? c.paramSchema : kernel.paramSchema;
  const defaults = Object.assign({}, kernel.defaults);
  for (const s of schema) if (s.def !== undefined) defaults[s.key] = s.def;
  return {
    id: c.id || ('custom-' + Date.now().toString(36)),
    kernel: kernel.id, builtin: false,
    name: c.name || '自定义场景', tagline: c.tagline || '自定义场景', description: c.description || '',
    resourceName: c.resourceName || kernel.resourceName || '',
    paramSchema: schema, defaults,
    interventions: (c.interventions && c.interventions.length) ? c.interventions : kernel.interventions,
    metricKeys: (c.metricKeys && c.metricKeys.length) ? c.metricKeys : kernel.metricKeys,
    agentTypes: c.agentTypes || kernel.agentTypes || [],
    init: kernel.init, step: kernel.step, metrics: kernel.metrics, visualize: kernel.visualize,
    totalTicks: kernel.totalTicks, onParamChange: kernel.onParamChange, intervene: kernel.intervene,
    describe: kernel.describe, liveCheck: kernel.liveCheck, detect: kernel.detect,
  };
}

function resolveScenario(body) {
  if (body.scenario && body.scenario !== 'custom') return { sc: SCENARIOS[body.scenario] || null, key: body.scenario };
  if (body.customScenario) { const sc = buildCustomScenario(body.customScenario); return { sc, key: sc ? sc.id : null }; }
  return { sc: null, key: null };
}

function createSim(sc, params, seed, key) {
  if (!sc) return null;
  const sim = new Simulation(sc, params, seed);
  const rec = { id: uid(), sim, playing: false, speed: 4, subs: new Set(), acc: 0, lastAccess: Date.now(), reportCache: null };
  sim.id = rec.id;
  sims.set(rec.id, rec);
  lastByScenario.set(key || sc.id, rec.id);
  return rec;
}

// 保存实验结果到磁盘（跨会话、跨浏览器可用于横向对比）
function saveResult(rec) {
  const report = redteam.buildReport(rec);
  const entry = {
    id: rec.sim.id, scenarioId: rec.sim.scenario.id, scenarioName: rec.sim.scenario.name,
    kernel: rec.sim.scenario.kernel || rec.sim.scenario.id, resourceName: rec.sim.resourceName || '',
    seed: rec.sim.seed, tick: rec.sim.tick, done: rec.sim.done,
    params: report.params, metrics: report.metrics, health: report.health,
    vulnerabilityCount: report.vulnerabilityCount,
    vulnerabilities: report.vulnerabilities.map(v => ({ name: v.name, severity: v.severity })),
    generatedAt: report.generatedAt,
  };
  const idx = results.findIndex(r => r.id === rec.sim.id);
  if (idx >= 0) results[idx] = entry; else results.push(entry);
  if (results.length > 200) results = results.slice(-200);
  persistResults();
  return entry;
}

function broadcast(rec, evt) {
  const snap = Object.assign({ playing: rec.playing, speed: rec.speed }, rec.sim.snapshot());
  const msg = `event: ${evt || 'tick'}\ndata: ${JSON.stringify(snap)}\n\n`;
  for (const res of rec.subs) {
    try { res.write(msg); } catch (e) { rec.subs.delete(res); }
  }
}

function liveCheckTick(rec) {
  const sim = rec.sim;
  if (sim.tick > 0 && sim.tick % 12 === 0 && !sim.done) {
    const alerts = sim.scenario.liveCheck(sim);
    for (const a of alerts) sim.log('redteam-alert', { pattern: a.pattern, msg: a.msg });
  }
}

// 全局时钟：每 100ms 按各自速度推进所有模拟
setInterval(() => {
  const now = Date.now();
  for (const [sid, rec] of sims) {
    if (now - rec.lastAccess > 30 * 60 * 1000) {
      rec.subs.forEach(r => { try { r.end(); } catch (e) { } });
      sims.delete(sid);
      continue;
    }
    if (rec.playing && !rec.sim.done) {
      rec.acc += rec.speed * 0.1;
      let n = Math.min(40, Math.floor(rec.acc));
      rec.acc -= n;
      let stepped = false;
      while (n-- > 0 && !rec.sim.done) { rec.sim.step(); stepped = true; }
      if (rec.sim.done) {
        rec.playing = false;
        lastCompleted.set(rec.sim.scenario.id, rec.id);
        saveResult(rec);
        broadcast(rec, 'done');
        continue;
      }
      if (stepped) { liveCheckTick(rec); broadcast(rec); }
    }
  }
}, 100);

function handleStream(req, res, rec) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify(rec.sim.snapshot())}\n\n`);
  rec.subs.add(res);
  const hb = setInterval(() => { try { res.write(':ping\n\n'); } catch (e) { } }, 15000);
  req.on('close', () => { clearInterval(hb); rec.subs.delete(res); });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (method === 'GET' && parts[1] === 'scenarios') {
    const list = Object.values(SCENARIOS).map(sc => scenarioMeta(sc));
    return send(res, 200, { scenarios: list });
  }

  if (method === 'POST' && parts[1] === 'generate' && parts.length === 2) {
    const body = await readBody(req);
    return send(res, 200, { proposal: generateScenario(body.name, body.description) });
  }

  if (parts[1] === 'results') {
    // 公网部署时可设 ADMIN_TOKEN，阻止陌生访客清空全站实验结果（不设则该保护关闭）
    if (method === 'DELETE') {
      const token = process.env.ADMIN_TOKEN;
      if (token && req.headers['x-admin-token'] !== token) return send(res, 403, { error: '需要管理令牌' });
    }
    if (method === 'GET') return send(res, 200, { results });
    if (method === 'DELETE' && parts[2]) { results = results.filter(r => r.id !== parts[2]); persistResults(); return send(res, 200, { ok: true }); }
    if (method === 'DELETE') { results = []; persistResults(); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'results endpoint' });
  }

  if (method === 'POST' && parts[1] === 'sims' && parts.length === 2) {
    const body = await readBody(req);
    const { sc, key } = resolveScenario(body);
    if (!sc) return send(res, 400, { error: '未知场景' });
    const rec = createSim(sc, body.params, body.seed, key);
    return send(res, 201, { simId: rec.id, scenario: scenarioMeta(sc), seed: rec.sim.seed });
  }

  if (method === 'GET' && parts[1] === 'sims' && parts.length === 2) {
    const qs = url.searchParams.get('scenario');
    const list = [...sims.values()]
      .filter(r => !qs || r.sim.scenario.id === qs)
      .map(r => ({ id: r.id, scenario: r.sim.scenario.id, tick: r.sim.tick, done: r.sim.done, seed: r.sim.seed }));
    return send(res, 200, { sims: list });
  }

  const m = url.pathname.match(/^\/api\/sims\/([^/]+)(?:\/(\w+))?$/);
  if (!m) return send(res, 404, { error: 'unknown endpoint' });
  const simId = m[1], sub = m[2];
  const rec = sims.get(simId);
  if (!rec) return send(res, 404, { error: '模拟不存在或已过期: ' + simId });
  rec.lastAccess = Date.now();

  if (!sub && method === 'GET') return send(res, 200, rec.sim.snapshot());
  if (sub === 'state' && method === 'GET') {
    const s = rec.sim.snapshot();
    s.events = rec.sim.events.slice(-200); // 报告页需要更完整的事件追溯
    return send(res, 200, s);
  }
  if (!sub && method === 'DELETE') {
    rec.subs.forEach(r => { try { r.end(); } catch (e) { } });
    sims.delete(simId);
    return send(res, 200, { ok: true });
  }

  if (sub === 'stream' && method === 'GET') return handleStream(req, res, rec);

  if (sub === 'control' && method === 'POST') {
    const body = await readBody(req);
    const action = body.action;
    if (action === 'play') { if (!rec.sim.done) rec.playing = true; }
    else if (action === 'pause') { rec.playing = false; }
    else if (action === 'step') { if (!rec.sim.done) { rec.sim.step(); liveCheckTick(rec); } }
    else if (action === 'speed') { rec.speed = Math.min(20, Math.max(0.5, +body.value || 4)); }
    else if (action === 'seek') { if (!rec.sim.done) rec.sim.seek(Math.max(0, +body.tick || 0)); }
    else if (action === 'reset') {
      const sc = rec.sim.scenario;
      const fresh = new Simulation(sc, body.params || rec.sim.params, body.seed != null ? body.seed : undefined);
      fresh.id = rec.id;
      rec.sim = fresh; rec.playing = false; rec.acc = 0; rec.reportCache = null;
      lastByScenario.set(sc.id, rec.id);
    }
    else return send(res, 400, { error: '未知控制: ' + action });
    broadcast(rec, action === 'reset' ? 'hello' : 'tick');
    return send(res, 200, { ok: true, tick: rec.sim.tick, done: rec.sim.done, playing: rec.playing });
  }

  if (sub === 'params' && method === 'POST') {
    const body = await readBody(req);
    const updates = body.updates || body;
    const sc = rec.sim.scenario;
    const applied = [];
    for (const [k, v] of Object.entries(updates)) {
      const s = sc.paramSchema.find(x => x.key === k);
      if (!s) continue;
      let val = v;
      if (s.type === 'number') val = +v;
      if (s.type === 'bool') val = !!v;
      rec.sim.setParam(k, val, s.label);
      applied.push(k);
    }
    broadcast(rec);
    return send(res, 200, { ok: true, applied });
  }

  if (sub === 'intervene' && method === 'POST') {
    const body = await readBody(req);
    const sc = rec.sim.scenario;
    if (!sc.interventions.find(x => x.action === body.action)) return send(res, 400, { error: '未知干预: ' + body.action });
    sc.intervene(rec.sim, body.action);
    broadcast(rec);
    return send(res, 200, { ok: true });
  }

  if (sub === 'report' && method === 'GET') {
    if (rec.reportCache && rec.reportCache.tick === rec.sim.tick) return send(res, 200, rec.reportCache.report);
    const report = redteam.buildReport(rec);
    rec.reportCache = { tick: rec.sim.tick, report };
    return send(res, 200, report);
  }

  if (sub === 'save' && method === 'POST') {
    const result = saveResult(rec);
    return send(res, 200, { ok: true, result });
  }

  if (sub === 'compare' && method === 'GET') {
    const withId = url.searchParams.get('with');
    let other = null;
    if (withId && sims.has(withId)) other = sims.get(withId);
    else {
      const cid = lastCompleted.get(rec.sim.scenario.id);
      if (cid && cid !== rec.id && sims.has(cid)) other = sims.get(cid);
    }
    if (!other) return send(res, 200, { available: false });
    return send(res, 200, {
      available: true,
      a: { simId: rec.id, seed: rec.sim.seed, ticks: rec.sim.tick, params: rec.sim.params },
      b: { simId: other.id, seed: other.sim.seed, ticks: other.sim.tick, params: other.sim.params },
      metricKeys: rec.sim.scenario.metricKeys,
      rows: (rec.sim.scenario.metricKeys || []).map(k => ({
        key: k.key, label: k.label, better: k.better,
        a: rec.sim.latestMetrics()[k.key], b: other.sim.latestMetrics()[k.key],
        delta: (rec.sim.latestMetrics()[k.key] != null && other.sim.latestMetrics()[k.key] != null)
          ? +(rec.sim.latestMetrics()[k.key] - other.sim.latestMetrics()[k.key]).toFixed(3) : null,
      })),
    });
  }

  if (sub === 'scan' && method === 'POST') {
    const vulns = rec.sim.scenario.detect(rec.sim);
    return send(res, 200, {
      tick: rec.sim.tick, found: vulns.length,
      vulnerabilities: vulns.map(v => ({ pattern: v.pattern, name: v.name, severity: v.severity, why: v.why })),
    });
  }

  return send(res, 404, { error: 'unknown endpoint: ' + sub });
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { rel = pathname; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'not found');
    sendText(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, sims: sims.size });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[server error]', e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

function lanIPs() {
  const os = require('os');
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('🧪 规则养蛊局 RULE LAB 已启动');
  console.log(`   本机:     http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`   局域网:   http://${ip}:${PORT}   （同一网络的其它设备用此地址访问）`);
  console.log(`   场景:     ${Object.values(SCENARIOS).map(s => s.name).join(' / ')}`);
  console.log(`   提示:     若其它设备无法访问，请确认 Windows 防火墙已放行 TCP ${PORT} 入站。`);
});
