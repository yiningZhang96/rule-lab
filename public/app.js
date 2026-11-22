'use strict';
/* RULE LAB 前端：零依赖 SPA */
const $ = s => document.querySelector(s);
const view = document.getElementById('view');
const PALETTE = ['#0d9488', '#2563eb', '#d97706', '#db2777', '#7c3aed', '#e11d48', '#ea580c', '#0891b2'];

const state = {
  scenarios: [],        // 内置场景（/api/scenarios）
  simId: null, scenarioId: null, scenario: null,
  es: null, charts: [], lastSeq: 0, lastViz: 0, seed: null, playing: false,
  resourceName: '', lastCache: 0, savedNotice: 0,
};

/* ---------- 工具 ---------- */
async function api(path, method, body) {
  const opt = method ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info');
  t.textContent = msg;
  document.getElementById('toast').appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}
function loadLS(key, def) { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch (e) { return def; } }
function saveLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { } }
function totalTicksOf(sc, params) {
  if (!sc) return null;
  if (sc.kernel === 'team-collab') return ((params && params.rounds) || 0) * 10;
  return ((params && params.days) || 0) * 24;
}

/* 指标格式化：结合 scenario.metricKeys 的 unit/pct/dec */
function metricMeta(key) {
  const sc = state.scenario;
  if (sc && sc.metricKeys) { const m = sc.metricKeys.find(k => k.key === key); if (m) return m; }
  return null;
}
function fmtValue(v, meta) {
  if (v == null || isNaN(v)) return '—';
  const m = meta || {};
  const dec = m.dec != null ? m.dec : 2;
  if (m.pct) return (v * 100).toFixed(dec) + '%';
  const unit = m.unit || '';
  return (+v).toFixed(dec) + unit;
}
function fmtMetric(key, v) { return fmtValue(v, metricMeta(key)); }

function setStatus(s) {
  const b = $('#simStatus'); if (!b) return;
  b.className = 'badge ' + (s === 'done' ? 'done' : s === 'running' ? 'running' : 'idle');
  b.textContent = s === 'done' ? '■ 已完成' : s === 'running' ? '● 运行中' : '‖ 已暂停';
}

/* ---------- 主题 ---------- */
function applyTheme(t) {
  const r = document.documentElement;
  r.setAttribute('data-theme', t.theme || 'light');
  if (t.accent) r.style.setProperty('--accent', t.accent);
  if (t.accent2) r.style.setProperty('--accent2', t.accent2);
  saveLS('rulelab.theme', t);
  renderThemePanel();
}
function getTheme() { return loadLS('rulelab.theme', { theme: 'light' }); }

function renderThemePanel() {
  const p = $('#themePanel');
  if (!p) return;
  const t = getTheme();
  p.innerHTML = `
    <h4>🎨 主题与配色</h4>
    <div class="theme-row"><span>主题模式</span>
      <span class="opts">
        <button class="seg ${t.theme !== 'dark' ? 'active' : ''}" data-theme-set="light">浅色</button>
        <button class="seg ${t.theme === 'dark' ? 'active' : ''}" data-theme-set="dark">深色</button>
      </span></div>
    <div class="theme-row"><span>主色</span>
      <span class="color-field"><input type="color" id="cAccent" value="${esc(t.accent || (t.theme === 'dark' ? '#34d399' : '#0d9488'))}"></span></div>
    <div class="theme-row"><span>辅助色</span>
      <span class="color-field"><input type="color" id="cAccent2" value="${esc(t.accent2 || (t.theme === 'dark' ? '#38bdf8' : '#2563eb'))}"></span></div>
    <button class="btn small" id="btnThemeReset" style="width:100%;margin-top:6px">恢复默认配色</button>`;
  p.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => {
    const cur = getTheme(); cur.theme = b.dataset.themeSet;
    applyTheme(cur);
  });
  $('#cAccent').oninput = e => { const cur = getTheme(); cur.accent = e.target.value; applyTheme(cur); };
  $('#cAccent2').oninput = e => { const cur = getTheme(); cur.accent2 = e.target.value; applyTheme(cur); };
  $('#btnThemeReset').onclick = () => { localStorage.removeItem('rulelab.theme'); document.documentElement.removeAttribute('style'); applyTheme({ theme: 'light' }); };
}
function toggleThemePanel(open) {
  const p = $('#themePanel'), b = $('#themeBackdrop');
  if (open == null) open = !p.classList.contains('open');
  p.classList.toggle('open', open);
  b.classList.toggle('open', open);
  if (open) renderThemePanel();
}

/* ---------- 自定义场景（localStorage） ---------- */
function customScenarios() {
  const list = loadLS('rulelab.custom', []);
  let changed = false;
  for (const c of list) {
    if (c && typeof c.id === 'string' && /[^\x00-\x7f]/.test(c.id)) {
      c.id = 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      changed = true;
    }
  }
  if (changed) saveLS('rulelab.custom', list);
  return list;
}
function saveCustomScenarios(list) { saveLS('rulelab.custom', list); }
function allScenarios() { return state.scenarios.concat(customScenarios()); }
function findScenario(id) {
  let d = id; try { d = decodeURIComponent(id); } catch (e) { }
  return allScenarios().find(s => s.id === id || s.id === d) || null;
}

/* 进度缓存 */
function cacheKey(scId) { return 'run:' + scId; }
function readRun(scId) { return loadLS(cacheKey(scId), null); }
function writeRun(scId, rec) { saveLS(cacheKey(scId), rec); }
function clearRun(scId) { localStorage.removeItem(cacheKey(scId)); }

/* ---------- 路由 ---------- */
function closeSSE() { if (state.es) { state.es.close(); state.es = null; } }
function setNav(top) {
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === top));
}
function route() {
  closeSSE();
  const h = location.hash || '#/';
  const parts = h.replace(/^#\//, '').split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  window.scrollTo(0, 0);
  if (parts[0] === 'lab' && parts[1]) renderLab(parts[1], parts[2]);
  else if (parts[0] === 'report' && parts[1]) renderReport(parts[1]);
  else if (parts[0] === 'create') renderCreate();
  else if (parts[0] === 'results') renderResults();
  else if (parts[0] === 'labs') renderLabs();
  else renderHome();
  setNav(parts[0] === 'lab' ? 'labs' : (parts[0] || 'home'));
}
window.addEventListener('hashchange', route);

/* ---------- 首页 ---------- */
async function renderHome() {
  if (!state.scenarios.length) state.scenarios = (await api('/api/scenarios')).scenarios;
  const customs = customScenarios();
  view.innerHTML = `
    <div class="hero">
      <h1>规则养蛊局</h1>
      <div class="slogan">RULE LAB · 规则由你制定，漏洞由它们发现</div>
      <p>一个基于虚拟人群模拟的现实制度压力测试平台。制定资源分配、任务分工、奖惩规则，
      投放数百个具有不同性格与策略的虚拟人物，观察个体逐利行为如何涌现为群体问题——
      资源垄断、恶意钻空、责任推诿、效率下降。红队机制主动搜寻制度漏洞，
      让规则设计者以极低的试错成本，在制度落地前发现风险。</p>
      <div class="stat-strip">
        <div class="stat"><b>${2 + customs.length}</b><span>实验场景</span></div>
        <div class="stat"><b>${state.scenarios.reduce((n, s) => n + s.paramSchema.length, 0)}</b><span>可调规则参数</span></div>
        <div class="stat"><b>∞</b><span>可自定义人物构成</span></div>
        <div class="stat"><b>0</b><span>付费 AI API</span></div>
        <div class="stat"><b>100%</b><span>实验可复现</span></div>
      </div>
    </div>
    <div class="section-title">选择实验室</div>
    <div class="sc-grid">
      ${state.scenarios.map(scCard).join('')}
      ${customs.map(scCard).join('')}
      <div class="sc-card" style="border-style:dashed">
        <div class="icon">✨</div><h3>自定义场景</h3><div class="tag">定义你的制度</div>
        <p>不局限于两个示例。描述你要测试的场景，系统为你构思一套规则，你再修改、确认并设定参数。</p>
        <a class="btn primary" href="#/create">新建场景 →</a>
      </div>
    </div>
    <div class="section-title">运行流程</div>
    <div class="steps">
      <div class="step"><div class="num">01</div><h4>定义场景</h4><p>从内置实验室入手，或描述你的场景让系统构思一套规则。</p></div>
      <div class="step"><div class="num">02</div><h4>制定规则</h4><p>每条规则都标注单位与含义；调整参数、设定虚拟人物类型与数量。</p></div>
      <div class="step"><div class="num">03</div><h4>观察与干预</h4><p>实时可视化群体动态，中途注入突发事件，规则运行中也能改。</p></div>
      <div class="step"><div class="num">04</div><h4>横向对比</h4><p>结果自动保存，跨多次实验横向对比，找到更公平高效的制度。</p></div>
    </div>
    <div class="section-title">平台能力</div>
    <div class="features">
      <div class="feature"><b>🤖 基于智能体的模拟（ABM）</b>智能体根据规则带来的收益、成本和风险自主选择行动，部分个体会主动搜寻制度漏洞。</div>
      <div class="feature"><b>🛡 红队策略搜索</b>运行中实时警报 + 实验后深度扫描，定位漏洞对应的具体规则与个体行为证据。</div>
      <div class="feature"><b>📼 完全可追溯</b>事件级日志记录每一次预约、申报、串通与违规，报告可回放到具体 tick 与个体。</div>
      <div class="feature"><b>🔁 可复现实验</b>种子化随机数生成器，相同规则 + 相同种子 → 完全相同的结果，支持严谨的 A/B 对比。</div>
      <div class="feature"><b>🧩 规则引擎</b>参数热更新：实验进行中修改规则，立即观察群体行为拐点。</div>
      <div class="feature"><b>💾 结果保存</b>实验结果自动写入磁盘，退出页面/浏览器不丢，可跨多次实验横向对比。</div>
    </div>`;
}

function scCard(sc) {
  const chips = (sc.paramSchema || []).slice(0, 6).map(s => `<span class="chip">${esc(s.label)}</span>`).join('');
  return `<div class="sc-card">
    <div class="icon">${sc.kernel === 'team-collab' ? '👥' : (sc.kernel === 'shared-resource' ? '🧺' : '✨')}</div>
    <h3>${esc(sc.name)}</h3>
    <div class="tag">${esc(sc.tagline)}</div>
    <p>${esc(sc.description)}</p>
    <div class="chips">${chips}${(sc.paramSchema || []).length > 6 ? `<span class="chip">+${sc.paramSchema.length - 6} 更多</span>` : ''}</div>
    <a class="btn primary" href="#/lab/${esc(sc.id)}">进入实验室 →</a>
  </div>`;
}

async function renderLabs() {
  if (!state.scenarios.length) state.scenarios = (await api('/api/scenarios')).scenarios;
  const customs = customScenarios();
  view.innerHTML = `
    <div class="section-title">内置实验室</div>
    <div class="sc-grid">${state.scenarios.map(scCard).join('')}</div>
    <div class="section-title">我的自定义场景</div>
    ${customs.length ? `<div class="sc-grid">${customs.map(scCard).join('')}</div>` : '<div class="panel hint">还没有自定义场景，点击「新建场景」开始。</div>'}
    <div class="sc-grid" style="grid-template-columns:1fr">
      <div class="sc-card" style="border-style:dashed"><div class="icon">✨</div><h3>新建场景</h3><div class="tag">定义你的制度</div>
      <p>描述你要测试的制度（如「校园电动车充电桩的预约与费用规则」），系统自动构思一套规则并让你逐条修改确认。</p>
      <a class="btn primary" href="#/create">✨ 新建场景 →</a></div>
    </div>`;
}

/* ---------- 新建场景向导 ---------- */
async function renderCreate() {
  const presets = ['校园电动车充电桩的预约与费用规则', '会议室/自习座位的抢占与爽约', '小组作业的评分与搭便车', '社团志愿者排班与刷工时', '公共停车位限时免费与超时收费'];
  view.innerHTML = `
    <div class="wizard">
      <div class="section-title">新建自定义场景</div>
      <div class="wizard-step">
        <h3>第 1 步 · 描述你的场景</h3>
        <p class="hint">不局限于两个示例。描述要测的制度/资源/协作方式，系统会据此构思一套规则（本地规则引擎，不调用 AI API）。</p>
        <div class="presets">${presets.map(p => `<span class="preset">${esc(p)}</span>`).join('')}</div>
        <label class="hint">场景名称</label>
        <input type="text" id="scName" placeholder="例如：校园充电桩制度" style="margin:6px 0 12px">
        <label class="hint">场景描述（资源、参与者、痛点）</label>
        <textarea id="scDesc" placeholder="例如：宿舍楼下有 8 个充电桩，50 位车主早晚高峰抢桩，有人预约了不来，有人充电超时。想测预约上限、爽约惩罚和分时电价怎么定。"></textarea>
        <div style="margin-top:12px"><button class="btn primary" id="btnGenerate">🤖 让系统构思规则</button></div>
        <div id="generateHint" class="hint" style="margin-top:10px"></div>
      </div>
      <div id="ruleEditor"></div>
      <div class="wizard-step" id="confirmStep" style="display:none">
        <button class="btn primary" id="btnConfirm">✅ 确认并进入实验室</button>
      </div>
    </div>`;

  const q = view;
  view.querySelectorAll('.preset').forEach(p => p.onclick = () => {
    $('#scName').value = p.textContent.split('的')[0] || p.textContent;
    $('#scDesc').value = p.textContent;
  });
  $('#btnGenerate').onclick = async () => {
    const name = $('#scName').value.trim(), desc = $('#scDesc').value.trim();
    if (!desc) { $('#generateHint').textContent = '请先填写场景描述。'; return; }
    $('#generateHint').textContent = '构思中…';
    try {
      const r = await api('/api/generate', 'POST', { name, description: desc });
      state.draftSc = r.proposal;
      state.draftIncluded = r.proposal.paramSchema.map(s => s.key);
      state.draftDeleted = [];
      renderRuleEditor(r.proposal);
      $('#generateHint').textContent = '已生成的规则草案，可逐条修改后确认。';
    } catch (e) { $('#generateHint').textContent = '生成失败：' + e.message; }
  };
  $('#btnConfirm').onclick = confirmDraft;
}

function renderRuleEditor(proposal) {
  const opts = proposal.paramSchema.filter(s => !state.draftIncluded.includes(s.key))
    .map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
  const rows = state.draftIncluded.map(key => {
    const s = proposal.paramSchema.find(x => x.key === key);
    const def = (s.type === 'number' || s.type === 'select') ? s.def : '';
    const unit = s.unit || '';
    return `<tr data-key="${key}">
      <td><input type="text" class="lbl" value="${esc(s.label)}"></td>
      <td><input type="text" class="unt" value="${esc(unit)}" style="width:60px"></td>
      <td><input type="text" class="hnt" value="${esc(s.hint || '')}"></td>
      <td>${s.type === 'bool' ? `<select class="def"><option value="true">开</option><option value="false">关</option></select>`
        : s.type === 'select' ? `<select class="def">${s.options.map(o => `<option value="${o.v}" ${o.v === s.def ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`
        : `<input type="number" class="def def-in" value="${def}">`}</td>
      <td><button class="del">✕</button></td>
    </tr>`;
  }).join('');
  $('#ruleEditor').innerHTML = `
    <div class="wizard-step">
      <h3>第 2 步 · 修改与确认规则 <span class="kernel-pill">引擎：${proposal.kernel === 'team-collab' ? '团队协作' : '共享资源'} · 资源：${esc(proposal.resourceName || '—')}</span></h3>
      <div style="margin-bottom:10px">
        <label class="hint">补充规则 </label>
        <select id="addRule"><option value="">— 从规则库选择 —</option>${opts}</select>
      </div>
      <table class="rule-table">
        <thead><tr><th style="width:22%">规则名称</th><th style="width:9%">单位</th><th style="width:38%">含义说明</th><th style="width:14%">默认值</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="hint" style="margin-top:8px">修改「规则名称 / 单位 / 含义说明」只会影响展示，不影响模拟逻辑；删除规则则该场景不再显示此参数（仍使用引擎默认值）。</div>
    </div>`;
  $('#confirmStep').style.display = 'block';
  $('#ruleEditor').querySelectorAll('.del').forEach(b => b.onclick = () => {
    const key = b.closest('tr').dataset.key;
    state.draftIncluded = state.draftIncluded.filter(k => k !== key);
    state.draftDeleted.push(key);
    renderRuleEditor(state.draftSc);
  });
  $('#addRule').onchange = e => {
    const key = e.target.value; if (!key) return;
    state.draftIncluded.push(key);
    state.draftDeleted = state.draftDeleted.filter(k => k !== key);
    renderRuleEditor(state.draftSc);
  };
}

function confirmDraft() {
  const p = state.draftSc;
  const keySet = new Set(state.draftIncluded);
  const paramSchema = state.draftIncluded.map(key => {
    const s = p.paramSchema.find(x => x.key === key);
    const tr = $('#ruleEditor').querySelector(`tr[data-key="${key}"]`);
    const label = tr.querySelector('.lbl').value.trim() || s.label;
    const unit = tr.querySelector('.unt').value.trim();
    const hint = tr.querySelector('.hnt').value.trim();
    const defEl = tr.querySelector('.def');
    let def = s.def;
    if (s.type === 'number') def = parseFloat(defEl.value) || 0;
    else if (s.type === 'bool') def = defEl.value === 'true';
    else def = defEl.value;
    return Object.assign({}, s, { label, unit: unit || undefined, hint: hint || undefined, def });
  });
  const sc = {
    id: 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kernel: p.kernel, name: p.name, tagline: p.tagline, description: p.description,
    resourceName: p.resourceName, paramSchema, metricKeys: p.metricKeys,
    agentTypes: p.agentTypes, interventions: p.interventions, createdAt: new Date().toISOString(),
  };
  saveCustomScenarios([sc].concat(customScenarios().filter(c => c.id !== sc.id)));
  state.draftSc = null;
  toast('场景已创建：' + sc.name, 'ok');
  location.hash = '#/lab/' + sc.id;
}

/* ---------- 实验室 ---------- */
async function renderLab(scId, simId) {
  const sc = findScenario(scId);
  if (!sc) { view.innerHTML = '<div class="panel">未知场景（自定义场景可能已被删除）</div>'; return; }
  state.scenario = sc; state.scenarioId = scId; state.resourceName = sc.resourceName || '';
  state.lastSeq = 0; state.lastViz = 0; state.charts = [];

  // 有 simId：直接加载；无：先查进度缓存，再决定恢复或新建
  if (!simId) {
    const run = readRun(scId);
    if (run) {
      return renderRestoreChoice(sc, run);
    }
    simId = await createSim(sc);
    if (!simId) return;
    history.replaceState(null, '', '#/lab/' + scId + '/' + simId);
  }
  await openLab(sc, simId);
}

async function createSim(sc, params, seed) {
  const payload = { params: params || {}, seed: (seed == null ? (Math.random() * 1e9) | 0 : seed) };
  if (sc.builtin) payload.scenario = sc.id;
  else payload.customScenario = { id: sc.id, kernel: sc.kernel, name: sc.name, tagline: sc.tagline, description: sc.description, resourceName: sc.resourceName, paramSchema: sc.paramSchema, metricKeys: sc.metricKeys, agentTypes: sc.agentTypes, interventions: sc.interventions };
  try {
    const r = await api('/api/sims', 'POST', payload);
    state.seed = r.seed;
    return r.simId;
  } catch (e) { toast('创建实验失败：' + e.message, 'error'); return null; }
}

function renderRestoreChoice(sc, run) {
  const pct = run.totalTicks ? Math.round(run.tick / run.totalTicks * 100) : 0;
  view.innerHTML = `
    <div class="wizard" style="max-width:760px">
      <div class="section-title">检测到上次实验进度</div>
      <div class="restore-banner">
        <div>🧪 <b>${esc(sc.name)}</b> · 进行到 tick ${run.tick}（约 ${pct}%）· 种子 ${run.seed}<br>
        <span class="hint">规则设置与人物构成已缓存。由于模拟完全可复现，将从同一随机种子快进恢复。</span></div>
        <button class="btn primary" id="btnRestore">▶ 恢复进度</button>
        <button class="btn" id="btnFresh">全新开始</button>
        <button class="btn ghost" id="btnCancel">取消</button>
      </div>
    </div>`;
  $('#btnRestore').onclick = async () => { await doRestore(sc, run); };
  $('#btnFresh').onclick = async () => { clearRun(sc.id); const id = await createSim(sc); if (id) { history.replaceState(null, '', '#/lab/' + sc.id + '/' + id); await openLab(sc, id); } };
  $('#btnCancel').onclick = () => location.hash = '#/labs';
}

async function doRestore(sc, run) {
  const id = await createSim(sc, run.params, run.seed);
  if (!id) return;
  history.replaceState(null, '', '#/lab/' + sc.id + '/' + id);
  await openLab(sc, id);
  try { await api('/api/sims/' + id + '/control', 'POST', { action: 'seek', tick: run.tick }); toast('已恢复到 tick ' + run.tick, 'ok'); }
  catch (e) { toast('恢复失败：' + e.message, 'error'); }
}

async function openLab(sc, simId) {
  state.simId = simId;
  buildLabDOM(sc);
  wireLabControls(sc);
  connectSSE(simId);
}

function buildLabDOM(sc) {
  view.innerHTML = `
  <div class="lab">
    <div class="panel lab-top">
      <div class="lab-title">
        <a class="back" href="#/labs">← 实验室</a>
        <div><h2>${sc.kernel === 'team-collab' ? '👥' : '🧺'} ${esc(sc.name)}</h2>
        <div class="tag">${esc(sc.tagline)} ${sc.builtin ? '' : '· 自定义'}</div></div>
        <span id="simStatus" class="badge idle">已创建</span>
      </div>
      <div class="lab-controls">
        <button id="btnPlay" class="btn primary">▶ 运行</button>
        <button id="btnStep" class="btn">⏭ 单步</button>
        <button id="btnReset" class="btn" title="相同种子重新开始">↺ 重置</button>
        <button id="btnSave" class="btn" title="保存本次结果用于横向对比">💾 保存结果</button>
        <label class="speed">速度 <input id="speed" type="range" min="0.5" max="20" step="0.5" value="4"><b id="speedVal">4</b></label>
        <span class="tick-pill">Tick <b id="tickNow">0</b></span>
        <button id="btnScan" class="btn warn">🛡 红队扫描</button>
        <a id="btnReport" class="btn ghost" href="#">📄 漏洞报告</a>
      </div>
    </div>
    <div class="lab-grid">
      <aside class="col">
        <div class="panel"><h3>⚙ 制度规则 <span class="hint-inline">（运行中可实时修改）</span></h3><div id="paramForm"></div></div>
        <div class="panel"><h3>⚡ 外部干预</h3><div id="interventions" class="iv-list"></div></div>
        <div class="panel"><h3>📜 规则修改记录</h3><ul id="ruleLog" class="rule-log"><li>暂无修改</li></ul></div>
      </aside>
      <section class="col">
        <div class="panel"><h3 id="vizTitle">实时可视化</h3><div id="viz"><p class="hint">等待数据流…</p></div></div>
        <div class="panel"><h3>指标走势</h3><div id="charts" class="charts"></div></div>
      </section>
      <aside class="col">
        <div class="panel"><h3>📊 关键指标</h3><div id="metricCards" class="metric-cards"></div></div>
        <div class="panel alert-panel"><h3>🛡 红队实时警报</h3><ul id="alerts" class="log"><li>红队监控中…</li></ul></div>
        <div class="panel"><h3>📡 事件日志</h3><ul id="log" class="log"></ul></div>
      </aside>
    </div>
    <div id="scanResult"></div>
  </div>`;
  buildParamForm(sc);
  buildInterventions(sc);
  buildCharts(sc);
}

/* 参数表单（含单位/说明/人物构成） */
function itemHTML(s, cur) {
  const val = cur == null ? s.def : cur;
  const q = s.hint ? `<span class="q" title="${esc(s.hint)}">?</span>` : '';
  const unitBadge = (s.type !== 'bool' && s.unit) ? `<span class="punit">${esc(s.unit)}</span>` : '';

  if (s.type === 'bool') {
    return `<div class="pitem">
      <span class="plabel">${esc(s.label)}${q}</span>
      <label class="switch"><input type="checkbox" data-k="${s.key}" ${val ? 'checked' : ''}><i></i></label>
      ${s.hint ? `<div class="phint-full">${esc(s.hint)}</div>` : ''}
    </div>`;
  }
  if (s.type === 'select') {
    return `<div class="pitem">
      <span class="plabel">${esc(s.label)}${q}</span>
      <select data-k="${s.key}">${s.options.map(o => `<option value="${o.v}" ${String(o.v) === String(val) ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>
      ${s.hint ? `<div class="phint-full">${esc(s.hint)}</div>` : ''}
    </div>`;
  }
  const scale = s.scale || 1;
  const curD = (+val) * scale;
  const mn = s.min * scale, mx = s.max * scale, st = s.step * scale;
  return `<div class="pitem">
    <div class="pitem-head"><span class="plabel">${esc(s.label)}${unitBadge}${q}</span><b id="pv-${s.key}">${curD}</b></div>
    <div class="range-row">
      <input type="range" data-k="${s.key}" data-scale="${scale}" min="${mn}" max="${mx}" step="${st}" value="${curD}">
      <input type="number" data-k="${s.key}" data-scale="${scale}" min="${mn}" max="${mx}" step="${st}" value="${curD}">
    </div>
    ${s.hint ? `<div class="phint-full">${esc(s.hint)}</div>` : ''}
  </div>`;
}

function buildParamForm(sc) {
  const form = $('#paramForm');
  const params = state.curParams || sc.defaults || {};
  const groups = {};
  for (const s of sc.paramSchema) (groups[s.group] = groups[s.group] || []).push(s);
  form.innerHTML = Object.entries(groups).map(([g, items]) =>
    `<div class="pgroup"><div class="pgroup-title">${esc(g)}</div>${items.map(s => itemHTML(s, params[s.key])).join('')}</div>`).join('');
  form.querySelectorAll('[data-k]').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.k;
      const schema = sc.paramSchema.find(x => x.key === key);
      const scale = +el.dataset.scale || 1;
      let v;
      if (schema.type === 'bool') v = el.checked;
      else if (schema.type === 'number') v = parseFloat(el.value) / scale;
      else v = el.value;
      if (schema.type === 'number') {
        const disp = parseFloat(el.value);
        form.querySelectorAll(`[data-k="${key}"]`).forEach(o => { o.value = disp; });
        const pv = document.getElementById('pv-' + key); if (pv) pv.textContent = disp;
      }
      applyParam(schema, v);
    });
  });
}

async function applyParam(schema, v) {
  if (!state.simId) return;
  try {
    await api(`/api/sims/${state.simId}/params`, 'POST', { updates: { [schema.key]: v } });
    const disp = schema.type === 'number' && schema.scale ? v * schema.scale : v;
    toast(`规则已实时生效：${schema.label} → ${disp}${schema.unit || ''}`, 'ok');
  } catch (e) { toast('规则修改失败：' + e.message, 'error'); }
}

function syncParamForm(params, sc) {
  sc = sc || state.scenario;
  document.querySelectorAll('#paramForm [data-k]').forEach(el => {
    const k = el.dataset.k;
    if (!(k in params)) return;
    const scale = +el.dataset.scale || 1;
    if (el.type === 'checkbox') el.checked = !!params[k];
    else el.value = params[k] * scale;
    const pv = document.getElementById('pv-' + k);
    if (pv) pv.textContent = params[k] * scale;
  });
}

function buildInterventions(sc) {
  const box = $('#interventions');
  box.innerHTML = (sc.interventions || []).map(iv =>
    `<button class="btn small" data-iv="${iv.action}" title="${esc(iv.desc)}">⚡ ${esc(iv.label)}</button>`).join('') +
    `<div class="hint" style="margin-top:8px">${esc((sc.interventions || []).map(i => i.label + '：' + i.desc).join('；'))}</div>`;
  box.querySelectorAll('[data-iv]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/sims/${state.simId}/intervene`, 'POST', { action: b.dataset.iv }); toast('已注入干预：' + b.textContent.trim(), 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

function buildCharts(sc) {
  const box = $('#charts');
  box.innerHTML = (sc.metricKeys || []).map((k, i) =>
    `<div class="chart-card"><div class="chart-title">${esc(k.label)}${k.unit ? '（' + esc(k.unit) + '）' : ''}</div><canvas id="chart-${k.key}"></canvas></div>`).join('');
  state.charts = (sc.metricKeys || []).map((k, i) =>
    new LineChart($('#chart-' + k.key), [{ key: k.key, label: k.label, color: PALETTE[i % PALETTE.length] }]));
}

function wireLabControls(sc) {
  const simId = state.simId;
  $('#btnReport').href = `#/report/${simId}`;
  $('#btnPlay').onclick = async () => {
    const playing = state.playing;
    await api(`/api/sims/${simId}/control`, 'POST', { action: playing ? 'pause' : 'play' });
    state.playing = !playing;
    $('#btnPlay').textContent = playing ? '▶ 运行' : '⏸ 暂停';
    setStatus(playing ? 'idle' : 'running');
  };
  $('#btnStep').onclick = async () => { await api(`/api/sims/${simId}/control`, 'POST', { action: 'step' }); };
  $('#btnReset').onclick = async () => {
    await api(`/api/sims/${simId}/control`, 'POST', { action: 'reset', params: state.curParams || undefined, seed: state.seed });
    toast('已按原种子重置实验', 'ok');
  };
  $('#btnSave').onclick = async () => {
    try { await api(`/api/sims/${simId}/save`, 'POST', {}); toast('结果已保存，可在「结果对比」查看', 'ok'); }
    catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
  $('#speed').oninput = e => { $('#speedVal').textContent = e.target.value; api(`/api/sims/${simId}/control`, 'POST', { action: 'speed', value: +e.target.value }).catch(() => { }); };
  $('#btnScan').onclick = async () => { try { const r = await api(`/api/sims/${simId}/scan`, 'POST', {}); renderScan(r); } catch (e) { toast(e.message, 'error'); } };
}

function renderScan(r) {
  const box = $('#scanResult');
  if (!r.found) { box.innerHTML = `<div class="panel ok">✅ 红队扫描（tick ${r.tick}）：未发现明显漏洞。</div>`; return; }
  box.innerHTML = `<div class="panel"><h3>🛡 红队扫描结果（tick ${r.tick}）· 发现 ${r.found} 项疑似漏洞</h3>
    ${r.vulnerabilities.map(v => `<div class="scan-item"><b>[${v.severity === 'high' ? '严重' : v.severity === 'medium' ? '中等' : '轻微'}] ${esc(v.name)}</b><br><span class="hint">${esc(v.why)}</span></div>`).join('')}
    <a class="btn small primary" href="#/report/${state.simId}" style="margin-top:10px">查看完整漏洞报告 →</a></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- SSE 实时流 ---------- */
function connectSSE(simId) {
  closeSSE();
  const es = new EventSource(`/api/sims/${simId}/stream`);
  es.addEventListener('hello', e => {
    const s = JSON.parse(e.data);
    state.seed = s.seed;
    state.resourceName = s.resourceName || state.resourceName;
    state.curParams = s.params;
    syncParamForm(s.params);
    updateAll(s);
  });
  es.addEventListener('tick', e => updateAll(JSON.parse(e.data)));
  es.addEventListener('done', e => {
    toast('🧫 实验结束，结果已自动保存', 'ok');
    setStatus('done');
  });
  es.onerror = () => { /* 自动重连 */ };
  state.es = es;
}

function updateAll(snap) {
  state.playing = !!snap.playing;
  $('#tickNow').textContent = snap.tick;
  setStatus(snap.done ? 'done' : snap.playing ? 'running' : 'idle');
  if (snap.resourceName) state.resourceName = snap.resourceName;
  const sc = state.scenario;

  // 指标卡
  const cards = (sc ? sc.metricKeys : []).map(k =>
    `<div class="mcard"><div class="mcard-label">${esc(k.label)}${k.unit ? '<span class="label-with-unit">' + esc(k.unit) + '</span>' : ''}</div><div class="mcard-val">${fmtValue(snap.metrics[k.key], k)}</div></div>`).join('');
  $('#metricCards').innerHTML = cards;
  for (const c of state.charts) c.draw(snap.history);

  // 可视化（节流）
  const now = performance.now();
  if (now - state.lastViz > 350) {
    state.lastViz = now;
    renderViz(snap);
    const rl = $('#ruleLog');
    if (rl) rl.innerHTML = snap.ruleLog.length
      ? snap.ruleLog.slice().reverse().map(r => `<li><b>#${r.tick}</b> ${esc(r.text)}</li>`).join('') : '<li>暂无修改</li>';
  }
  // 事件日志 & 警报
  const fresh = snap.events.filter(e => e.seq > state.lastSeq);
  if (fresh.length) {
    state.lastSeq = Math.max(state.lastSeq, ...fresh.map(e => e.seq));
    const log = $('#log'), alerts = $('#alerts');
    for (const ev of fresh.reverse()) {
      const li = document.createElement('li');
      li.className = 'ev-' + ev.type;
      li.innerHTML = `<span class="ev-tick">#${ev.tick}</span>${esc(describeEvent(ev))}`;
      log.prepend(li);
      if (ev.type === 'redteam-alert') {
        const al = document.createElement('li');
        al.className = 'ev-redteam-alert';
        al.innerHTML = `<span class="ev-tick">#${ev.tick}</span>${esc(ev.msg || '')}`;
        alerts.prepend(al); toast('🛡 ' + (ev.msg || '红队发现异常'), 'info');
      }
    }
    while (log.children.length > 60) log.lastChild.remove();
    while (alerts.children.length > 20) alerts.lastChild.remove();
  }
  // 进度缓存（节流 1s）
  if (now - state.lastCache > 1000) {
    state.lastCache = now;
    writeRun(state.scenarioId, { seed: snap.seed, tick: snap.tick, done: snap.done, params: snap.params, totalTicks: totalTicksOf(sc, snap.params), savedAt: Date.now() });
  }
}

function describeEvent(ev) {
  const r = state.resourceName || '资源';
  const map = {
    'reserve': () => `用户 #${ev.agent} ${ev.prime ? '预约了高峰时段' : '预约了普通时段'}${r} #${ev.machine}`,
    'reserve-hoard': () => `用户 #${ev.agent}（${ev.arch}）同时持有 ${ev.slots} 个预约，疑似囤积`,
    'no-show': () => `用户 #${ev.agent}（${ev.arch}）预约爽约，浪费${r} #${ev.machine} 的${ev.prime ? '高峰' : ''}时段`,
    'overrun': () => `用户 #${ev.agent}（${ev.arch}）超时占用${r} #${ev.machine} 额外 1 小时`,
    'conflict': () => `用户 #${ev.agent} 到达预约时段，${r} #${ev.machine} 被超时占用者占据`,
    'violation': () => `用户 #${ev.agent} 的违规（${ev.kind}）被记录，扣罚 ${ev.penalty} 积分`,
    'param-change': () => `规则修改：${ev.label} ${JSON.stringify(ev.from)} → ${JSON.stringify(ev.to)}`,
    'intervene': () => `外部干预：${ev.msg}`,
    'redteam-alert': () => `[红队警报] ${ev.msg}`,
    'task-failed': () => `团队 ${ev.team} 任务 #${ev.task} 烂尾（投入 ${ev.spent}/${ev.req}）`,
    'audit-catch': () => `成员 #${ev.agent}（${ev.arch}）申报 ${ev.claimed} 被审计抓包，真实 ${ev.true}，扣罚 ${ev.penalty} 积分`,
    'collusion-review': () => `成员 #${ev.agent} 与 #${ev.reviewer} 互评串通（评分 ${ev.rating} / 真实 ${ev.true}）`,
    'broken-promise': () => `成员 #${ev.agent} 竞拍承诺 ${ev.promised}，实际投入 ${ev.spent}`,
    'free-ride-caught': () => `成员 #${ev.agent}（${ev.arch}）投入 ${ev.effort} 低于中位数 ${ev.median}，判定搭便车，扣罚 ${ev.penalty} 积分`,
    'member-leave': () => ev.msg,
  };
  return (map[ev.type] || (() => ev.type + ' ' + esc(JSON.stringify(ev))))();
}

/* ---------- 场景可视化 ---------- */
function renderViz(snap) {
  if ((state.scenario && state.scenario.kernel) === 'team-collab') renderTeamViz(snap);
  else renderSharedViz(snap);
}

function renderSharedViz(snap) {
  const viz = snap.viz, p = snap.params, t = snap.tick;
  const rn = state.resourceName || '资源';
  const machines = viz.machines.map(m => {
    const st = m.busy ? (m.overstayed ? ['超时占用', 'bus-over'] : ['运行中', 'busy']) : (m.reservedNext.length ? ['已预约', 'reserved'] : ['空闲', 'idle']);
    const prog = m.busy ? Math.min(100, Math.max(0, (1 - (m.until - t) / (p.washTicks || 1)) * 100)) : 0;
    return `<div class="machine ${st[1]}">
      <div class="machine-head"><span class="dot"></span>${esc(rn)} #${m.id}<span class="machine-status">${st[0]}</span></div>
      <div class="machine-body">${m.busy ? `用户 #${m.user} · 剩余 ${Math.max(0, m.until - t)} 小时` : '等待使用'}</div>
      ${m.busy ? `<div class="bar"><i style="width:${prog}%"></i></div>` : ''}
      ${m.reservedNext.length ? `<div class="resv">预约：${m.reservedNext.map(x => '+' + (x - t)).join(', ')} 小时后</div>` : ''}
    </div>`;
  }).join('');
  const queue = viz.queue.map(q => `<span class="chip">${esc(q.arch)} #${q.agent}${q.points ? ` · ${q.points}积分` : ''}</span>`).join('') || '<span class="hint">队列空</span>';
  const top = viz.topAgents.map(a => `<tr class="${a.exploit > 0.6 ? 'exploit' : ''}">
    <td>#${a.id}</td><td>${esc(a.arch)}</td><td>${a.washes}</td><td>${a.prime}</td><td>${a.reserves}</td><td>${a.noShows}</td><td>${a.overruns}</td><td>${a.violations}</td></tr>`).join('');
  $('#viz').innerHTML = `
    <div class="viz-grid2">
      <div><h4>${esc(rn)}状态</h4><div class="machine-grid">${machines}</div>
        <h4>Top 使用者（按使用次数）</h4>
        <table class="tbl"><thead><tr><th>用户</th><th>类型</th><th>使用</th><th>高峰</th><th>预约</th><th>爽约</th><th>超时</th><th>违规</th></tr></thead><tbody>${top}</tbody></table>
      </div>
      <div><h4>等待队列（${viz.queue.length + viz.waiting.length} 人）</h4><div class="chips">${queue}</div>
        <h4>${esc(rn)}占用热力图（近 48 小时）</h4>
        <canvas id="heat"></canvas>
        <div class="heat-legend"><i style="background:#94a3b8"></i>空闲 <i style="background:#14b8a6"></i>运行 <i style="background:#f43f5e"></i>超时 <i style="background:#f59e0b"></i>已预约</div>
      </div>
    </div>`;
  drawHeatmap($('#heat'), viz.timeline);
}

function renderTeamViz(snap) {
  const viz = snap.viz, p = snap.params;
  const phaseName = viz.phase === 0 ? '任务分配' : viz.phase === 9 ? '评分结算' : '工作中';
  const diffName = { easy: '简单', med: '中等', hard: '困难' };
  const teams = viz.teams.map(tm => {
    const tasks = tm.tasks.map(t => `<div class="task ${t.completed ? 'done' : ''}">
        <span class="badge diff-${t.diff}">${diffName[t.diff]}${t.urgent ? ' ⚡' : ''}</span>
        <span class="badge vis-${t.vis}">${t.vis === 'high' ? '高可见' : '低可见'}</span>
        <span class="task-prog"><i style="width:${Math.min(100, t.spent / t.req * 100)}%"></i></span>
        <span class="task-num">${t.spent}/${t.req}</span>
        <span class="task-pts">${t.points}分</span>
      </div>`).join('');
    const members = tm.members.map(a => `<div class="member ${a.departed ? 'departed' : ''}">
        <span class="m-name">${esc(a.arch)} #${a.id}${a.id === tm.leader ? ' 👑' : ''}</span>
        <span class="m-bar"><i style="width:${Math.min(100, a.effort / (p.effortBudget || 1) * 100)}%"></i></span>
        <span class="m-num">${a.effort}/${p.effortBudget}</span>
        <span class="m-score">${a.score}分 / 奖${a.reward}</span>
        <span class="m-caught">${a.caught ? '⚠' + a.caught : ''}</span>
      </div>`).join('');
    return `<div class="team-card">
      <div class="team-head">团队 ${tm.id} · 总分 <b>${tm.score}</b> <span class="hint">本轮 +${tm.roundScore}</span></div>
      <div class="team-tasks">${tasks}</div>
      <div class="team-members">${members}</div>
    </div>`;
  }).join('');
  $('#viz').innerHTML = `
    <div class="round-bar">第 ${viz.round + 1} 轮 / 共 ${p.rounds} 轮 · 阶段：${phaseName}（tick ${snap.tick}）</div>
    <div class="teams-grid">${teams}</div>`;
}

/* ---------- 报告 ---------- */
async function renderReport(simId) {
  let report;
  try { report = await api(`/api/sims/${simId}/report`); }
  catch (e) { view.innerHTML = `<div class="panel"><h2>报告不可用</h2><p class="hint">${esc(e.message)}。</p><a class="btn primary" href="#/labs">返回实验室</a></div>`; return; }
  state.resourceName = report.resourceName || state.resourceName;
  const healthCls = report.health >= 75 ? 'hi' : report.health >= 45 ? 'mid' : 'lo';
  const paramRows = Object.entries(report.params).map(([k, v]) =>
    `<tr><td>${esc(v.label)}</td><td><code>${esc(JSON.stringify(v.value))}</code></td></tr>`).join('');
  const metricRows = report.metricKeys.map(k =>
    `<tr><td>${esc(k.label)}${k.unit ? '<span class="label-with-unit">' + esc(k.unit) + '</span>' : ''}</td><td>${fmtValue(report.metrics[k.key], k)}</td></tr>`).join('');
  const vulns = report.vulnerabilities.length
    ? report.vulnerabilities.map(v => vulnHTML(report, v)).join('')
    : `<div class="panel ok">✅ 红队未发现重大制度漏洞。这套规则经受住了考验。</div>`;
  view.innerHTML = `
    <div class="panel report-head">
      <div><h2>🧫 漏洞报告 · ${esc(report.scenarioName)}</h2>
        <div class="hint">模拟 ${report.ticks}/${report.totalTicks} ticks · 种子 ${report.seed} · 生成于 ${new Date(report.generatedAt).toLocaleString('zh-CN')}</div></div>
      <div class="health ${healthCls}" style="margin-left:auto">制度健康度<b>${report.health}</b>/100</div>
    </div>
    <div class="report-actions">
      <button class="btn small" id="btnDownload">⬇ 下载报告 JSON</button>
      <a class="btn small" href="#/lab/${report.scenarioId}/${report.simId}">↩ 返回实验继续调整</a>
    </div>
    <div class="lab-grid">
      <aside class="col">
        <div class="panel"><h3>📊 最终指标</h3><table class="tbl"><tbody>${metricRows}</tbody></table></div>
        <div class="panel"><h3>⚙ 实验规则</h3><table class="tbl"><tbody>${paramRows}</tbody></table></div>
        <div class="panel"><h3>📜 规则修改与干预记录</h3><ul class="rule-log">${report.ruleLog.length ? report.ruleLog.map(r => `<li><b>#${r.tick}</b> ${esc(r.text)}</li>`).join('') : '<li>本次运行未修改规则</li>'}</ul></div>
      </aside>
      <section class="col" style="grid-column:span 2">
        <div class="section-title">发现漏洞 ${report.vulnerabilityCount} 项</div>
        ${vulns}
        <div class="section-title">A/B 对比</div>
        <div class="panel"><h3>与基线运行对比（相同指标）</h3><div id="compareBox"><p class="hint">加载中…</p></div></div>
        <div class="panel"><h3>🔢 原始事件日志（${report.eventCount} 条，证据级追溯）</h3>
          <button class="btn small" id="btnEvents">展开最近 200 条事件</button>
          <ul id="rawEvents" class="log" style="display:none;max-height:300px"></ul></div>
      </section>
    </div>`;
  $('#btnDownload').onclick = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `rule-lab-report-${report.simId}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  $('#btnEvents').onclick = async () => {
    const ul = $('#rawEvents');
    if (ul.style.display !== 'none') { ul.style.display = 'none'; return; }
    const snap = await api(`/api/sims/${simId}/state`);
    ul.innerHTML = snap.events.slice(-200).reverse().map(e => `<li><span class="ev-tick">#${e.tick}</span>${esc(describeEvent(e))}</li>`).join('') || '<li>无事件</li>';
    ul.style.display = 'block';
  };
  view.querySelectorAll('[data-fix-key]').forEach(b => b.onclick = () => applyFix(report, b.dataset.fixKey, JSON.parse(b.dataset.fixVal)));
  loadCompare(report);
}

function vulnHTML(report, v) {
  const fixLabel = (report.params[v.fix.key] && report.params[v.fix.key].label) || v.fix.key;
  const curVal = report.params[v.fix.key] ? report.params[v.fix.key].value : '?';
  return `<div class="vuln sev-${v.severity}">
    <div class="vuln-head"><span class="sev sev-${v.severity}">${v.severityLabel}</span><h4>${v.no}. ${esc(v.name)}</h4><code>${esc(v.pattern)}</code></div>
    <p class="why">${esc(v.why)}</p>
    <div class="vuln-row"><span class="k">触发规则</span><b>${esc(v.trigger.label)}</b> = <code>${esc(JSON.stringify(v.trigger.value))}</code></div>
    <div class="vuln-row"><span class="k">造成影响</span>${esc(v.impact.text)}（<code>${esc(v.impact.metric)}: ${v.impact.value}</code>）</div>
    <details><summary>📼 可追溯证据（${v.evidence.length} 条事件）</summary>
      <ul class="evidence">${v.evidence.length ? v.evidence.map(e => `<li><span class="ev-tick">tick ${e.tick}</span>${esc(e.text)}${e.agent != null ? ` <span class="hint">（涉及 #${e.agent}）</span>` : ''}</li>`).join('') : '<li>（本次运行未采样到相关事件）</li>'}</ul>
    </details>
    <div class="fix"><div>💡 <b>修复建议</b>：将「${esc(fixLabel)}」从 <code>${esc(JSON.stringify(curVal))}</code> 调整为 <code>${esc(JSON.stringify(v.fix.value))}</code> —— ${esc(v.fix.rationale)}</div>
      <button class="btn small primary" data-fix-key="${esc(v.fix.key)}" data-fix-val='${esc(JSON.stringify(v.fix.value))}'>🧪 应用修复并重跑（同种子）</button></div>
  </div>`;
}

async function applyFix(report, key, val) {
  const params = {};
  for (const [k, v] of Object.entries(report.params)) params[k] = v.value;
  params[key] = val;
  toast('正在用修复后的规则重新实验（同种子）…');
  try {
    const sd = report.scenarioDef;
    let payload = { params, seed: report.seed };
    if (sd && sd.builtin === false) {
      payload.scenario = 'custom';
      payload.customScenario = {
        id: sd.id, kernel: sd.kernel, name: sd.name, tagline: sd.tagline, description: sd.description,
        resourceName: sd.resourceName, paramSchema: sd.paramSchema, metricKeys: sd.metricKeys,
        agentTypes: sd.agentTypes, interventions: sd.interventions,
      };
    } else {
      payload.scenario = report.scenarioId;
    }
    const r = await api('/api/sims', 'POST', payload);
    location.hash = `#/lab/${report.scenarioId}/${r.simId}`;
  } catch (e) { toast('重跑失败：' + e.message, 'error'); }
}

async function loadCompare(report) {
  const box = $('#compareBox');
  let r;
  try { r = await api(`/api/sims/${report.simId}/compare`); } catch (e) { box.innerHTML = '<p class="hint">对比加载失败</p>'; return; }
  if (!r.available) { box.innerHTML = '<p class="hint">暂无对比基线：先完成一次实验，修改规则后重置重跑，即可自动对比。</p>'; return; }
  const metaOf = key => (report.metricKeys || []).find(k => k.key === key) || null;
  const rows = r.rows.map(row => {
    const good = row.delta == null ? null : (row.better === 'high' ? row.delta > 0 : row.delta < 0);
    const arrow = row.delta == null ? '—' : (row.delta > 0 ? `▲ +${row.delta}` : row.delta < 0 ? `▼ ${row.delta}` : '— 0');
    const m = metaOf(row.key);
    return `<tr><td>${esc(row.label)}</td><td>${fmtValue(row.b, m)}</td><td>${fmtValue(row.a, m)}</td>
      <td class="${good == null ? '' : good ? 'good' : 'bad'}">${arrow}</td></tr>`;
  }).join('');
  box.innerHTML = `<table class="tbl"><thead><tr><th>指标</th><th>基线（#${r.b.simId.slice(-6)}）</th><th>本次（#${r.a.simId.slice(-6)}）</th><th>本次-基线</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:8px">基线为同场景上一次完成的实验，结果亦已保存，可在「结果对比」做更多次横向分析。</p>`;
}

/* ---------- 结果对比 ---------- */
async function renderResults() {
  view.innerHTML = `<div class="results"><div class="section-title">实验结果 · 横向对比</div><p class="hint" id="rsHint">加载中…</p><div id="rsBody"></div></div>`;
  state.resultsSel = state.resultsSel || [];
  try {
    const r = await api('/api/results');
    state.resultsData = r.results || [];
  } catch (e) { $('#rsHint').textContent = '加载失败：' + e.message; return; }
  renderResultsList();
}

function renderResultsList() {
  const results = state.resultsData || [];
  if (!results.length) {
    $('#rsBody').innerHTML = `<div class="panel hint">还没有保存的实验结果。去实验室运行一次实验，结果会自动保存到这里。</div>`;
    return;
  }
  const groups = {};
  for (const r of results) (groups[r.scenarioName] = groups[r.scenarioName] || []).push(r);
  const sel = state.resultsSel;
  const filter = state.resultsFilter;
  const body = Object.entries(groups).map(([name, list]) => {
    if (filter && name !== filter) return '';
    const cards = list.map(r => {
      const mk = metricKeysForResult(r);
      const metrics = mk.map(k => `<span class="rmetric">${esc(k.label)} ${fmtValue(r.metrics[k.key], k)}</span>`).join('');
      const active = sel.includes(r.id);
      return `<div class="result-card ${active ? 'sel' : ''}" data-rid="${r.id}">
        <div class="r-head"><b>${esc(r.scenarioName)}</b>${r.resourceName ? `<span class="chip">${esc(r.resourceName)}</span>` : ''}
          <span class="r-meta">种子 ${r.seed} · ${new Date(r.generatedAt).toLocaleString('zh-CN')} · 健康度 ${r.health} · 漏洞 ${r.vulnerabilityCount}</span>
          ${active ? '<span class="badge done">已选</span>' : ''}</div>
        <div class="result-metrics">${metrics}</div>
      </div>`;
    }).join('');
    return `<div class="result-group"><div class="section-title">${esc(name)}</div>${cards}</div>`;
  }).filter(Boolean).join('');

  $('#rsBody').innerHTML = `
    <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label class="hint">按场景筛选
        <select id="rsFilter"><option value="">全部</option>${Object.keys(groups).map(g => `<option value="${esc(g)}" ${filter === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      </label>
      <button class="btn small primary" id="rsCompare">📊 对比选中（${sel.length}）</button>
      <button class="btn small" id="rsExport">⬇ 导出全部 JSON</button>
      <button class="btn small warn" id="rsClear">清空全部结果</button>
      <span class="hint">点击卡片可选中/取消选中，最多对比 5 次实验。</span>
    </div>
    ${body}
    <div id="cmpBox"></div>`;
  $('#rsBody').querySelectorAll('.result-card').forEach(c => c.onclick = () => {
    const id = c.dataset.rid;
    if (sel.includes(id)) sel.splice(sel.indexOf(id), 1); else { if (sel.length >= 5) { toast('最多同时对比 5 次实验', 'error'); return; } sel.push(id); }
    renderResultsList();
  });
  $('#rsFilter').onchange = e => { state.resultsFilter = e.target.value || null; renderResultsList(); };
  $('#rsCompare').onclick = renderComparison;
  $('#rsExport').onclick = () => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rule-lab-results.json'; a.click(); URL.revokeObjectURL(a.href);
  };
  $('#rsClear').onclick = async () => {
    if (!confirm('确定清空全部实验结果？此操作不可撤销。')) return;
    await api('/api/results', 'DELETE'); state.resultsData = []; state.resultsSel = []; toast('已清空', 'ok'); renderResultsList();
  };
  if (sel.length) $('#cmpBox').scrollIntoView({ behavior: 'smooth' });
}

function metricKeysForResult(r) {
  // 用对应内置场景的 metricKeys 口径；自定义场景 priority 稍后从内置映射
  const sc = state.scenarios.find(s => s.kernel === r.kernel || s.id === r.scenarioId) || state.scenarios[0];
  return sc ? sc.metricKeys : [];
}

function renderComparison() {
  const sel = state.resultsSel, box = $('#cmpBox');
  if (!sel.length) { box.innerHTML = ''; return; }
  const rows = state.resultsData.filter(r => sel.includes(r.id));
  const base = rows[0];
  const sc = state.scenarios.find(s => s.kernel === base.kernel || s.id === base.scenarioId) || state.scenarios[0];
  const mk = sc ? sc.metricKeys : [];
  const fmt = (v, k) => fmtValue(v, k);
  const head = `<tr><th>指标</th>${rows.map(r => `<th>#${r.id.slice(-6)}<br><span class="hint">${esc(r.resourceName || r.scenarioName)}</span></th>`).join('')}</tr>`;
  const body = mk.map(k => {
    return `<tr><td>${esc(k.label)}${k.unit ? '<span class="label-with-unit">' + esc(k.unit) + '</span>' : ''}</td>${rows.map(r => `<td>${fmt(r.metrics[k.key], k)}</td>`).join('')}</tr>`;
  }).join('');
  // 参数差异
  const paramKeys = new Set(); rows.forEach(r => Object.keys(r.params).forEach(k => paramKeys.add(k)));
  const differing = [...paramKeys].filter(k => {
    const vals = rows.map(r => r.params[k] ? r.params[k].value : undefined).filter(v => v !== undefined);
    return vals.length > 1 && !vals.every(v => JSON.stringify(v) === JSON.stringify(vals[0]));
  });
  const paramDiff = differing.map(k => {
    const label = rows.map(r => r.params[k] && r.params[k].label).find(Boolean) || k;
    return `<div class="scan-item">${esc(label)}：${rows.map(r => `<code style="margin-right:6px">${esc(JSON.stringify(r.params[k] ? r.params[k].value : '—'))}</code>`).join('')}</div>`;
  }).join('');
  box.innerHTML = `
    <div class="panel"><h3>📊 指标对比（${rows.length} 次实验）</h3>
      <div class="cmp-table-wrap"><table class="tbl hl"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <h4 style="margin-top:16px">规则差异（仅列出不同的参数）</h4>
      ${paramDiff || '<p class="hint">各次实验规则参数完全一致。</p>'}
    </div>`;
}

/* ---------- 启动 ---------- */
(async function boot() {
  document.getElementById('btnTheme').onclick = () => toggleThemePanel();
  document.getElementById('themeBackdrop').onclick = () => toggleThemePanel(false);
  try {
    state.scenarios = (await api('/api/scenarios')).scenarios;
  } catch (e) {
    view.innerHTML = '<div class="panel"><h2>无法连接服务器</h2><p class="hint">请确认已运行 node server.js</p></div>';
    return;
  }
  route();
})();