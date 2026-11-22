'use strict';
// 场景 1：共享资源实验室 —— 宿舍洗衣机 / 公共设备预约使用模拟
// 观察：资源囤积、恶意预约（爽约）、高峰垄断、分配不公、超时占用
const { gini, topShare, mean, clamp } = require('../metrics');

const id = 'shared-resource';

const AGENT_TYPES = [
  { key: 'count-obedient', arch: '守法者', label: '守法者', hint: '遵纪守法、按需正常使用的普通用户', def: 26 },
  { key: 'count-opportunist', arch: '机会主义者', label: '机会主义者', hint: '风险可控时会钻空子、占便宜的用户', def: 12 },
  { key: 'count-exploiter', arch: '钻营者', label: '钻营者', hint: '主动寻找规则漏洞、囤积资源的高风险用户', def: 10 },
  { key: 'count-altruist', arch: '奉献者', label: '奉献者', hint: '克己利他、几乎不占便宜的用户', def: 8 },
  { key: 'count-freerider', arch: '搭便车者', label: '搭便车者', hint: '不愿付出、倾向蹭他人便利的用户', def: 4 },
];

const BASE_PARAMS = [
  { key: 'machineCount', label: '洗衣机数量', unit: '台', type: 'number', min: 1, max: 30, step: 1, def: 8, group: '资源', hint: '可供使用的共享设备（洗衣机）总数' },
  { key: 'days', label: '模拟时长', unit: '天', type: 'number', min: 3, max: 30, step: 1, def: 14, group: '时间', hint: '模拟的总天数；1 天 = 24 个时段，每时段 = 1 小时' },
  { key: 'washTicks', label: '单次洗涤时长', unit: '小时', type: 'number', min: 1, max: 4, step: 1, def: 2, group: '资源', hint: '每次使用该资源需占用的时长；1 时段 = 1 小时' },
  { key: 'reservationEnabled', label: '开放预约', type: 'bool', def: true, group: '规则', hint: '是否允许用户提前预约资源' },
  { key: 'maxReservations', label: '每人同时预约上限', unit: '个', type: 'number', min: 1, max: 6, step: 1, def: 2, group: '规则', hint: '单个用户同时持有的未使用预约数量上限（越大越易囤积）' },
  { key: 'leadSlots', label: '最长提前预约', unit: '小时', type: 'number', min: 1, max: 48, step: 1, def: 8, group: '规则', hint: '最早可提前多少小时进行预约' },
  { key: 'noShowPenalty', label: '爽约惩罚', unit: '积分', type: 'number', min: 0, max: 100, step: 5, def: 25, group: '规则', hint: '预约后未到场扣除的虚拟积分（影响积分优先排队与满意度）；非现金罚款，仅为本实验的积分变量' },
  { key: 'overrunAllowed', label: '允许超时占用', type: 'bool', def: true, group: '规则', hint: '是否允许超出预约/规定时长继续占用' },
  { key: 'overrunPenalty', label: '超时惩罚', unit: '积分', type: 'number', min: 0, max: 100, step: 5, def: 15, group: '规则', hint: '超时占用且被发现时扣除的虚拟积分' },
  { key: 'usageFee', label: '每次使用费用', unit: '积分', type: 'number', min: 0, max: 20, step: 1, def: 0, group: '经济', hint: '每次使用资源需支付的虚拟积分（本实验的虚拟货币，非真实金额）' },
  { key: 'peakSurge', label: '高峰时段价格倍率', unit: '倍', type: 'number', min: 1, max: 3, step: 0.1, def: 1.5, group: '经济', hint: '高峰时段（18:00–23:00）费用乘以该倍率' },
  { key: 'queueMode', label: '排队规则', type: 'select', def: 'fcfs', options: [
    { v: 'fcfs', l: '先到先得' }, { v: 'lottery', l: '随机抽签' }, { v: 'points', l: '积分优先' }], group: '规则', hint: '资源空闲时的分配顺序：先到先得 / 等概率抽签 / 等待积分高者优先' },
  { key: 'offPeakReward', label: '错峰使用奖励', type: 'bool', def: false, group: '经济', hint: '非高峰时段使用可额外获得积分奖励' },
  { key: 'detection', label: '违规发现概率', unit: '%', scale: 100, type: 'number', min: 0, max: 1, step: 0.05, def: 0.45, group: '监管', hint: '违规行为（爽约/超时）被系统抽查发现的概率' },
];

const agentTypeParams = AGENT_TYPES.map(t => ({
  key: t.key, label: t.label, unit: '人', type: 'number', min: 0, max: 80, step: 1, def: t.def,
  group: '虚拟人物', hint: t.hint + '（修改人物构成后需重置实验生效）',
}));

const PARAM_SCHEMA = BASE_PARAMS.concat(agentTypeParams);

const DEFAULTS = {};
for (const s of PARAM_SCHEMA) DEFAULTS[s.key] = s.def;

const INTERVENTIONS = [
  { action: 'machineDown', label: '设备故障', desc: '随机一台设备故障 12 小时' },
  { action: 'demandSpike', label: '突发需求', desc: '30% 用户使用需求激增' },
  { action: 'addMachine', label: '扩充设备', desc: '立刻新增一台设备' },
  { action: 'inspect', label: '突击检查', desc: '未来 24 小时违规发现概率提升至 90%' },
];

const METRIC_KEYS = [
  { key: 'utilization', label: '设备利用率', unit: '%', pct: true, dec: 1, better: 'high' },
  { key: 'avgWait', label: '平均等待时长', unit: '小时', dec: 1, better: 'low' },
  { key: 'gini', label: '分配基尼系数', unit: '', dec: 3, better: 'low' },
  { key: 'noShowRate', label: '爽约率', unit: '%', pct: true, dec: 1, better: 'low' },
  { key: 'satisfaction', label: '满意度', unit: '分', dec: 0, better: 'high' },
];

function isPrime(t) { const h = t % 24; return h >= 18 && h < 23; } // 18:00-23:00 为高峰

const ARCH_TRAITS = {
  '守法者':   { exploit: [0.05, 0.25], diligence: [0.55, 0.95], patience: [0.5, 1.0], risk: [0.15, 0.45] },
  '机会主义者': { exploit: [0.35, 0.60], diligence: [0.4, 0.8], patience: [0.3, 0.8], risk: [0.35, 0.65] },
  '钻营者':   { exploit: [0.70, 1.0], diligence: [0.3, 0.7], patience: [0.2, 0.6], risk: [0.6, 1.0] },
  '奉献者':   { exploit: [0.02, 0.12], diligence: [0.85, 1.0], patience: [0.8, 1.0], risk: [0.1, 0.3] },
  '搭便车者': { exploit: [0.25, 0.45], diligence: [0.1, 0.3], patience: [0.3, 0.6], risk: [0.3, 0.6] },
};

function makeAgent(i, arch, rng) {
  const t = ARCH_TRAITS[arch] || ARCH_TRAITS['守法者'];
  const traits = {
    exploit: rng.range(t.exploit[0], t.exploit[1]),
    diligence: rng.range(t.diligence[0], t.diligence[1]),
    patience: rng.range(t.patience[0], t.patience[1]),
    risk: rng.range(t.risk[0], t.risk[1]),
  };
  return {
    id: i, arch, traits,
    need: rng.range(5, 55), threshold: rng.range(35, 72),
    washes: 0, primeWashes: 0, reserves: 0, noShows: 0, overruns: 0, conflicts: 0, violations: 0,
    waitTicks: 0, wantTick: -1, points: 0, utility: 0,
    reservations: [], washing: null, queued: false, waiting: false,
  };
}

function buildTypePool(sim) {
  const pool = [];
  for (const t of AGENT_TYPES) {
    const n = Math.max(0, Math.round(sim.params[t.key] || 0));
    for (let i = 0; i < n; i++) pool.push(t.arch);
  }
  return pool;
}

function init(sim) {
  sim.machines = [];
  const mc = Math.max(1, Math.round(sim.params.machineCount || 1));
  for (let i = 0; i < mc; i++) {
    sim.machines.push({ id: i, busyUntil: -1, reserved: new Set(), user: null, overstayed: false, timeline: [] });
  }
  let pool = buildTypePool(sim);
  if (!pool.length) { // 全部为 0 时回退到默认构成
    for (const t of AGENT_TYPES) for (let i = 0; i < t.def; i++) pool.push(t.arch);
  }
  sim.rng.shuffle(pool);
  sim.params.population = pool.length;
  sim.agents = pool.map((arch, i) => makeAgent(i, arch, sim.rng));
  sim.queue = [];     // {agent, since}
  sim.waiting = [];   // 预约被超时占用后优先排队 {agent, machine}
  sim.reservations = []; // {agent, tick, machine}
  sim.stats = { reservations: 0, noShows: 0, overruns: 0, conflicts: 0, washes: 0, violations: 0, busyTicks: 0, waits: [] };
  sim.overrides = []; // 临时规则覆盖（如突击检查）
  sim._alertState = {};
}

function totalTicks(sim) { return sim.params.days * 24; }

function effParam(sim, key) { return sim.params[key]; }

function feeFor(sim, t) {
  const p = sim.params;
  return p.usageFee * (isPrime(t) ? p.peakSurge : 1);
}

function dropReservations(sim, agent) {
  if (!agent.reservations.length) return;
  const mine = new Set(agent.reservations.map(r => r.tick + ':' + r.machine));
  for (const m of sim.machines) {
    for (const tick of [...m.reserved]) {
      if (mine.has(tick + ':' + m.id)) m.reserved.delete(tick);
    }
  }
  sim.reservations = sim.reservations.filter(r => r.agent !== agent);
  agent.reservations = [];
}

function startWash(sim, agent, machine, t, fromReservation) {
  const p = sim.params;
  let dur = p.washTicks;
  const pOver = p.overrunAllowed
    ? clamp(0.03 + 0.35 * agent.traits.exploit * (1 - p.overrunPenalty / 100) + 0.08 * agent.traits.risk, 0, 0.8)
    : 0;
  if (sim.rng.chance(pOver)) {
    dur += 1;
    agent.overruns++; sim.stats.overruns++;
    machine.overstayed = true;
    sim.log('overrun', { agent: agent.id, arch: agent.arch, machine: machine.id, extraTicks: 1 });
    if (sim.rng.chance(effParam(sim, 'detection'))) {
      agent.violations++; agent.utility -= p.overrunPenalty * 0.08;
      sim.log('violation', { agent: agent.id, kind: '超时占用被记录', penalty: p.overrunPenalty });
    }
  }
  machine.busyUntil = t + dur;
  machine.user = agent.id;
  machine.reserved.delete(t);
  agent.washing = { machine: machine.id, until: t + dur };
  agent.queued = false; agent.waiting = false;
  agent.washes++; sim.stats.washes++;
  if (isPrime(t)) agent.primeWashes++;
  let w = 0;
  if (agent.wantTick >= 0) {
    w = Math.max(0, t - agent.wantTick);
    agent.waitTicks += w; sim.stats.waits.push(w);
    agent.wantTick = -1;
  }
  const net = agent.need * 0.5 - feeFor(sim, t) - w * 0.3;
  agent.utility += (net - agent.utility) * 0.08; // 衰减平均，避免效用无界增长
  agent.need = 0;
  if (!isPrime(t) && p.offPeakReward) agent.points = Math.min(30, agent.points + 3);
  // 排队/直接使用被服务后，放弃其它预约（正常用户行为）；预约到点使用者保留其余预约（囤积者继续制造爽约）
  if (sim.queue.some(q => q.agent === agent)) sim.queue = sim.queue.filter(q => q.agent !== agent);
  if (!fromReservation) dropReservations(sim, agent);
}

function noShowProb(agent, p) {
  const e = agent.traits.exploit;
  if (e > 0.6) return clamp(0.08 + 0.45 * (1 - p.noShowPenalty / 100) + 0.15 * agent.traits.risk, 0, 0.9);
  if (e > 0.35) return clamp(0.04 + 0.25 * (1 - p.noShowPenalty / 100), 0, 0.5);
  return 0.01;
}

function processReservations(sim, t) {
  const due = sim.reservations.filter(r => r.tick === t);
  if (!due.length) return;
  sim.reservations = sim.reservations.filter(r => r.tick !== t); // 先移除，避免重复触发
  for (const res of due) {
    const a = res.agent, m = sim.machines[res.machine];
    if (!m || a.washing) continue; // 已在洗涤中则预约作废
    if (sim.rng.chance(noShowProb(a, sim.params))) {
      a.noShows++; sim.stats.noShows++;
      a.utility -= sim.params.noShowPenalty * 0.05;
      sim.log('no-show', { agent: a.id, arch: a.arch, machine: m.id, prime: isPrime(t) });
      if (sim.rng.chance(effParam(sim, 'detection'))) {
        a.violations++; a.utility -= sim.params.noShowPenalty * 0.08;
        sim.log('violation', { agent: a.id, kind: '恶意预约爽约被记录', penalty: sim.params.noShowPenalty });
      }
    } else if (m.busyUntil > t) {
      a.conflicts++; sim.stats.conflicts++;
      sim.log('conflict', { agent: a.id, machine: m.id, msg: '预约时段被上一位超时占用者占据' });
      a.waiting = true;
      sim.waiting.push({ agent: a, machine: m, priority: true });
    } else {
      startWash(sim, a, m, t, true);
    }
  }
}

function tryReserve(sim, agent, hoard) {
  const p = sim.params, t = sim.tick;
  const cand = [];
  for (let k = 1; k <= p.leadSlots; k++) cand.push({ tt: t + k, prime: isPrime(t + k) });
  cand.sort((x, y) => (y.prime - x.prime) || (x.tt - y.tt));
  for (const c of cand) {
    const free = sim.machines.filter(m => m.busyUntil <= c.tt && !m.reserved.has(c.tt));
    if (!free.length) continue;
    free.sort((m1, m2) => m1.reserved.size - m2.reserved.size);
    const m = free[0];
    m.reserved.add(c.tt);
    agent.reservations.push({ tick: c.tt, machine: m.id });
    agent.reserves++; sim.stats.reservations++;
    sim.reservations.push({ agent, tick: c.tt, machine: m.id });
    if (hoard || agent.reservations.length >= 2) {
      sim.log('reserve-hoard', { agent: agent.id, arch: agent.arch, slots: agent.reservations.length, machine: m.id, prime: c.prime });
    } else {
      sim.log('reserve', { agent: agent.id, machine: m.id, prime: c.prime });
    }
    return true;
  }
  return false;
}

function joinQueue(sim, agent) {
  agent.queued = true;
  sim.queue.push({ agent, since: sim.tick });
}

function serveQueue(sim) {
  const t = sim.tick;
  // 被超时占用挤掉的预约者优先
  for (const w of sim.waiting) {
    if (w.agent.washing) { w.done = true; continue; }
    if (w.machine.busyUntil <= t) { w.done = true; startWash(sim, w.agent, w.machine, t); }
  }
  sim.waiting = sim.waiting.filter(w => !w.done && !w.agent.washing);
  // 普通队列
  while (sim.queue.length) {
    const m = sim.machines.find(mm => mm.busyUntil <= t);
    if (!m) break;
    let idx = 0;
    const mode = sim.params.queueMode;
    if (mode === 'lottery') idx = (sim.rng.float() * sim.queue.length) | 0;
    else if (mode === 'points') {
      let tot = 0;
      for (const q of sim.queue) tot += 1 + q.agent.points;
      let r = sim.rng.float() * tot;
      idx = sim.queue.length - 1;
      for (let i = 0; i < sim.queue.length; i++) { r -= 1 + sim.queue[i].agent.points; if (r <= 0) { idx = i; break; } }
    }
    const q = sim.queue.splice(idx, 1)[0];
    if (q.agent.washing) continue;
    startWash(sim, q.agent, m, t);
  }
}

function demand(sim) {
  const p = sim.params, t = sim.tick;
  for (const a of sim.agents) {
    if (a.washing || a.wantTick < 0 || a.queued || a.waiting) continue;
    if (a.reservations.length > 0) continue;
    const idle = sim.machines.find(m => m.busyUntil <= t && !m.reserved.has(t));
    if (idle) { startWash(sim, a, idle, t); continue; }
    const canReserve = p.reservationEnabled && a.reservations.length < p.maxReservations;
    const nearFree = sim.machines.some(m => m.busyUntil <= t + 2 && !m.reserved.has(t + 1) && !m.reserved.has(t + 2));
    if (a.traits.exploit > 0.6 && canReserve) {
      // 钻营者：批量抢占高峰预约位（囤积）
      let want = p.maxReservations - a.reservations.length;
      while (want-- > 0) { if (!tryReserve(sim, a, true)) break; }
    } else if (canReserve && (sim.queue.length >= 2 || !nearFree)) {
      tryReserve(sim, a, false);
    } else if (sim.rng.chance(a.traits.patience * 0.9 + 0.1)) {
      joinQueue(sim, a);
    }
    // 否则 defer，下个 tick 再决策
  }
}

function step(sim) {
  const p = sim.params, t = sim.tick, rng = sim.rng;
  // 临时规则覆盖到期恢复
  sim.overrides = sim.overrides.filter(o => {
    if (o.until <= t) { sim.params[o.key] = o.orig; return false; }
    return true;
  });
  // 1. 需求增长（晚间集中爆发，模拟真实作息）
  const h = t % 24;
  const growthMult = (h >= 17 && h < 24) ? 2.3 : (h >= 7 && h < 9) ? 1.3 : 0.65;
  for (const a of sim.agents) {
    a.need += (1.1 + rng.float() * 1.6) * growthMult;
    if (rng.chance(0.02)) a.need += 22; // 运动日
    if (a.wantTick < 0 && a.need >= a.threshold) a.wantTick = t;
  }
  // 2. 释放机器 + 清理过期预约占位 + 解除完成洗涤的住户状态
  for (const a of sim.agents) if (a.washing && a.washing.until <= t) a.washing = null;
  for (const m of sim.machines) {
    if (m.busyUntil > 0 && m.busyUntil <= t) { m.user = null; m.overstayed = false; }
    for (const v of [...m.reserved]) if (v < t - 1) m.reserved.delete(v);
  }
  // 3. 处理到期预约
  processReservations(sim, t);
  // 4. 服务队列
  serveQueue(sim);
  // 5. 新需求决策
  demand(sim);
  // 6. 排队积分
  if (p.queueMode === 'points') {
    for (const q of sim.queue) q.agent.points = Math.min(30, q.agent.points + 1);
  }
  // 7. 记录机器时间线（前端热力图）
  for (const m of sim.machines) {
    const code = m.busyUntil > t ? (m.overstayed ? 2 : 1) : (m.reserved.has(t) ? 3 : 0);
    m.timeline.push(code);
    if (m.timeline.length > 96) m.timeline.shift();
  }
  sim.stats.busyTicks += sim.machines.filter(m => m.busyUntil > t).length;
}

function metrics(sim) {
  const p = sim.params, t = Math.max(1, sim.tick);
  const util = sim.stats.busyTicks / (p.machineCount * t);
  const waits = sim.stats.waits;
  const avgWait = waits.length ? mean(waits) : 0;
  const g = gini(sim.agents.map(a => a.washes));
  const noShowRate = sim.stats.reservations ? sim.stats.noShows / sim.stats.reservations : 0;
  const primeTop = topShare(sim.agents.map(a => a.primeWashes), 0.1);
  const sat = mean(sim.agents.map(a => clamp(50 + a.utility * 2.2, 0, 100)));
  return {
    utilization: +util.toFixed(3),
    avgWait: +avgWait.toFixed(2),
    gini: +g.toFixed(3),
    noShowRate: +noShowRate.toFixed(3),
    overruns: sim.stats.overruns,
    conflicts: sim.stats.conflicts,
    primeMonopoly: +primeTop.toFixed(3),
    satisfaction: +sat.toFixed(1),
    washes: sim.stats.washes,
    queueLen: sim.queue.length + sim.waiting.length,
  };
}

function visualize(sim) {
  const t = sim.tick;
  return {
    tick: t,
    machines: sim.machines.map(m => ({
      id: m.id, busy: m.busyUntil > t, until: m.busyUntil, user: m.user, overstayed: m.overstayed,
      reservedNext: [...m.reserved].filter(x => x >= t).sort((a, b) => a - b).slice(0, 3),
    })),
    queue: sim.queue.slice(0, 24).map(q => ({ agent: q.agent.id, arch: q.agent.arch, points: q.agent.points, since: q.since })),
    waiting: sim.waiting.map(w => ({ agent: w.agent.id, machine: w.machine.id })),
    timeline: sim.machines.map(m => m.timeline.slice(-48)),
    topAgents: sim.agents.slice().sort((a, b) => b.washes - a.washes).slice(0, 8)
      .map(a => ({ id: a.id, arch: a.arch, washes: a.washes, prime: a.primeWashes, reserves: a.reserves, noShows: a.noShows, overruns: a.overruns, violations: a.violations, exploit: +a.traits.exploit.toFixed(2) })),
    totals: sim.stats,
  };
}

function onParamChange(sim, key, value) {
  if (key === 'machineCount') {
    const n = Math.max(1, Math.round(value));
    while (sim.machines.length < n) sim.machines.push({ id: sim.machines.length, busyUntil: -1, reserved: new Set(), user: null, overstayed: false, timeline: [] });
    sim.machines.length = n;
  }
  // 人物构成类参数（count-*）修改后需重置实验生效，不在运行中即时重建
}

function intervene(sim, action) {
  const rng = sim.rng, t = sim.tick;
  if (action === 'machineDown') {
    const m = rng.pick(sim.machines);
    m.busyUntil = t + 12; m.overstayed = false;
    sim.noteRule(`干预：机器 #${m.id} 故障 12 时段`);
    sim.log('intervene', { action, msg: `机器 #${m.id} 故障 12 时段` });
  } else if (action === 'demandSpike') {
    let n = 0;
    for (const a of sim.agents) if (rng.chance(0.3)) { a.need += 40; n++; }
    sim.log('intervene', { action, msg: `突发需求：${n} 名住户洗衣需求激增` });
  } else if (action === 'addMachine') {
    if (sim.machines.length < 16) {
      sim.machines.push({ id: sim.machines.length, busyUntil: -1, reserved: new Set(), user: null, overstayed: false, timeline: [] });
      sim.params.machineCount = sim.machines.length;
      sim.log('intervene', { action, msg: '扩充设备：新增一台洗衣机' });
    }
  } else if (action === 'inspect') {
    sim.overrides.push({ key: 'detection', orig: sim.params.detection, until: t + 24 });
    sim.params.detection = 0.9;
    sim.log('intervene', { action, msg: '突击检查：未来 24 时段违规发现概率 90%' });
  }
}

// ---------- 描述事件（报告/日志可读化） ----------
function resourceOf(sim) { return (sim && sim.resourceName) || '资源'; }

function describe(ev, sim) {
  const r = resourceOf(sim);
  switch (ev.type) {
    case 'reserve': return `用户 #${ev.agent} ${ev.prime ? '预约了高峰时段' : '预约了普通时段'}${r} #${ev.machine}`;
    case 'reserve-hoard': return `用户 #${ev.agent}（${ev.arch}）同时持有 ${ev.slots} 个预约${ev.prime ? '（含高峰时段）' : ''}，疑似囤积预约位`;
    case 'no-show': return `用户 #${ev.agent}（${ev.arch}）预约爽约，浪费了${r} #${ev.machine} 的${ev.prime ? '高峰' : ''}时段`;
    case 'overrun': return `用户 #${ev.agent}（${ev.arch}）超时占用${r} #${ev.machine} 额外 1 小时`;
    case 'conflict': return `用户 #${ev.agent} 到达预约时段，发现${r} #${ev.machine} 被超时占用者占据`;
    case 'violation': return `用户 #${ev.agent} 的违规行为（${ev.kind}）被记录，扣罚 ${ev.penalty} 积分`;
    case 'param-change': return `规则修改：${ev.label} ${JSON.stringify(ev.from)} → ${JSON.stringify(ev.to)}`;
    case 'intervene': return `外部干预：${ev.msg}`;
    case 'redteam-alert': return `[红队警报] ${ev.msg}`;
    default: return ev.type;
  }
}

// ---------- 实时红队警报（运行中每 12 tick 扫描一次） ----------
function liveCheck(sim) {
  const st = sim._alertState || (sim._alertState = {});
  const t = sim.tick, out = [];
  const cool = (k, cd) => { if (st[k] && t - st[k] < cd) return false; st[k] = t; return true; };
  const p = sim.params;
  const topWash = topShare(sim.agents.map(a => a.washes), 0.1);
  if (p.reservationEnabled && p.maxReservations >= 2 && topWash > 0.42 && cool('hoard', 24)) {
    out.push({ pattern: 'hoarding', msg: `红队发现：顶部 10% 用户占据 ${(topWash * 100).toFixed(0)}% 使用次数，存在预约囤积` });
  }
  const nsr = sim.stats.reservations ? sim.stats.noShows / sim.stats.reservations : 0;
  if (nsr > 0.1 && cool('ghost', 24)) out.push({ pattern: 'ghost-booking', msg: `红队发现：爽约率 ${(nsr * 100).toFixed(1)}%，疑似恶意预约` });
  if (sim.stats.overruns > sim.params.population * 0.25 && cool('overrun', 24)) {
    out.push({ pattern: 'overstay', msg: `红队发现：累计超时占用 ${sim.stats.overruns} 次，资源被长期霸占` });
  }
  const primeTop = topShare(sim.agents.map(a => a.primeWashes), 0.1);
  if (primeTop > 0.5 && cool('peak', 24)) out.push({ pattern: 'peak-monopoly', msg: `红队发现：高峰时段 ${(primeTop * 100).toFixed(0)}% 被顶部 10% 用户垄断` });
  return out;
}

// ---------- 漏洞检测（实验结束后生成报告） ----------
function evidence(sim, types, agentIds, limit) {
  const set = new Set(agentIds);
  return sim.events
    .filter(e => types.includes(e.type) && (e.agent == null || set.has(e.agent)))
    .slice(-(limit || 8))
    .map(e => ({ tick: e.tick, agent: e.agent, text: describe(e, sim) }));
}

function detect(sim) {
  const p = sim.params, agents = sim.agents, s = sim.stats, out = [];
  const washes = agents.map(a => a.washes);
  const topWash = topShare(washes, 0.1);
  const topRes = topShare(agents.map(a => a.reserves), 0.1);
  const g = gini(washes);
  const noShowRate = s.reservations ? s.noShows / s.reservations : 0;
  const avgWait = s.waits.length ? mean(s.waits) : 0;
  const p90Wait = s.waits.length ? require('../metrics').percentile(s.waits, 0.9) : 0;
  const primeTop = topShare(agents.map(a => a.primeWashes), 0.1);
  const overTickShare = s.overruns / Math.max(1, p.machineCount * sim.tick);
  const worstHoarders = agents.slice().sort((a, b) => b.reserves - a.reserves).slice(0, 5).map(a => a.id);
  const worstNoShow = agents.slice().sort((a, b) => b.noShows - a.noShows).slice(0, 5).map(a => a.id);
  const worstOverrun = agents.slice().sort((a, b) => b.overruns - a.overruns).slice(0, 5).map(a => a.id);
  const worstPrime = agents.slice().sort((a, b) => b.primeWashes - a.primeWashes).slice(0, 5).map(a => a.id);

  if (p.reservationEnabled && p.maxReservations >= 2 && s.reservations >= 20 && topWash > 0.42) {
    out.push({
      pattern: 'hoarding', name: '预约囤积 / 资源垄断', severity: topWash > 0.5 ? 'high' : 'medium',
      why: `预约上限为 ${p.maxReservations} 且可提前 ${p.leadSlots} 个时段预约，高钻营倾向个体批量抢占预约位。顶部 10% 住户占据 ${(topWash * 100).toFixed(1)}% 的洗涤次数和 ${(topRes * 100).toFixed(1)}% 的预约位，其他人被迫长时间排队。`,
      trigger: { key: 'maxReservations', label: '每人同时预约上限', value: p.maxReservations },
      evidence: evidence(sim, ['reserve-hoard', 'no-show'], worstHoarders),
      impact: { metric: '分配基尼系数', value: g, text: `洗涤次数基尼系数 ${g.toFixed(2)}，平均等待 ${avgWait.toFixed(1)} 时段，P90 等待 ${p90Wait.toFixed(0)} 时段` },
      fix: { key: 'maxReservations', value: 1, rationale: '将同时预约上限降为 1，并把提前预约窗口缩短到 4 时段内，囤积策略将无利可图' },
    });
  }

  if (s.reservations >= 10 && noShowRate > 0.08) {
    out.push({
      pattern: 'ghost-booking', name: '恶意预约 / 幽灵占位', severity: noShowRate > 0.18 ? 'high' : 'medium',
      why: `爽约惩罚仅 ${p.noShowPenalty}、违规发现概率 ${p.detection}，预约的违约成本过低。爽约率 ${(noShowRate * 100).toFixed(1)}%（共 ${s.noShows} 次），被预约的时段对其他人不可用，造成设备空转。`,
      trigger: { key: 'noShowPenalty', label: '爽约惩罚', value: p.noShowPenalty },
      evidence: evidence(sim, ['no-show'], worstNoShow),
      impact: { metric: '爽约率', value: noShowRate, text: `爽约率 ${(noShowRate * 100).toFixed(1)}%，浪费约 ${s.noShows} 个机器时段` },
      fix: { key: 'noShowPenalty', value: 50, rationale: '爽约惩罚提高到 50 以上（或引入预约押金），违约成本高于收益后恶意预约会自然消失' },
    });
  }

  if (s.overruns > Math.max(5, sim.params.population * 0.5)) {
    out.push({
      pattern: 'overstay', name: '超时占用 / 责任推诿', severity: overTickShare > 0.08 ? 'high' : 'medium',
      why: `规则允许超时占用且惩罚仅 ${p.overrunPenalty}。累计超时 ${s.overruns} 次，直接导致后续预约者到达时设备仍被占据（冲突 ${s.conflicts} 次）。`,
      trigger: { key: 'overrunPenalty', label: '超时惩罚', value: p.overrunPenalty },
      evidence: evidence(sim, ['overrun', 'conflict'], worstOverrun),
      impact: { metric: '预约冲突次数', value: s.conflicts, text: `超时 ${s.overruns} 次引发 ${s.conflicts} 次预约冲突，遵守规则的人被迫等待` },
      fix: { key: 'overrunPenalty', value: 40, rationale: '超时惩罚提高到 40，或直接关闭"允许超时占用"；配合自动断电提醒效果更好' },
    });
  }

  if (primeTop > 0.36 && avgWait > 1.5) {
    out.push({
      pattern: 'peak-monopoly', name: '高峰时段垄断', severity: primeTop > 0.6 ? 'high' : 'medium',
      why: `晚间高峰（18-23 时）需求集中，顶部 10% 住户占据 ${(primeTop * 100).toFixed(1)}% 的高峰洗涤。缺乏价格杠杆时，先到者/会预约者通吃黄金时段。`,
      trigger: { key: 'peakSurge', label: '高峰时段价格倍率', value: p.peakSurge },
      evidence: evidence(sim, ['reserve', 'reserve-hoard'], worstPrime),
      impact: { metric: '高峰垄断份额', value: primeTop, text: `高峰时段被顶部 10% 占据 ${(primeTop * 100).toFixed(1)}%，平均等待 ${avgWait.toFixed(1)} 时段` },
      fix: { key: 'peakSurge', value: 2.2, rationale: '高峰价格倍率提高到 2 以上，并开启"错峰使用奖励积分"，需求会被平滑到白天' },
    });
  }

  if (g > 0.38 && p.queueMode !== 'points') {
    out.push({
      pattern: 'queue-unfair', name: '排队规则不公', severity: g > 0.45 ? 'high' : 'medium',
      why: `当前排队规则"${{ fcfs: '先到先得', lottery: '随机抽签', points: '积分优先' }[p.queueMode]}"下，洗涤次数基尼系数达 ${g.toFixed(2)}。先到先得奖励有空闲时间的人，随机抽签则完全无视等待痛苦。`,
      trigger: { key: 'queueMode', label: '排队规则', value: p.queueMode },
      evidence: evidence(sim, ['conflict'], agents.slice().sort((a, b) => b.waitTicks - a.waitTicks).slice(0, 5).map(a => a.id)),
      impact: { metric: '分配基尼系数', value: g, text: `基尼系数 ${g.toFixed(2)}，最幸运的一批人洗衣次数是最不幸者的数倍` },
      fix: { key: 'queueMode', value: 'points', rationale: '改为"积分优先"：等待每时段累积积分，积分高者优先被服务，等待痛苦得到补偿' },
    });
  }

  const anyExploit = out.some(v => ['hoarding', 'ghost-booking', 'overstay'].includes(v.pattern));
  if (anyExploit && p.detection < 0.4) {
    out.push({
      pattern: 'weak-detection', name: '监管缺位 / 违规成本过低', severity: 'low',
      why: `多项钻营行为同时存在，但违规发现概率仅 ${p.detection}。当"被抓"几乎不可能时，守法反而成为劣势策略。`,
      trigger: { key: 'detection', label: '违规发现概率', value: p.detection },
      evidence: evidence(sim, ['violation'], agents.slice().sort((a, b) => b.violations - a.violations).slice(0, 5).map(a => a.id)),
      impact: { metric: '违规记录数', value: s.violations, text: `仅记录 ${s.violations} 次违规，大量钻营行为未被发现` },
      fix: { key: 'detection', value: 0.6, rationale: '将违规发现概率提升到 0.6 以上（如设备计时传感器 + 抽查），可显著抑制钻营动机' },
    });
  }

  return out;
}

module.exports = {
  id, name: '共享资源实验室', tagline: '宿舍洗衣机 · 公共设备预约', kernel: 'shared-resource', resourceName: '洗衣机',
  description: '模拟宿舍洗衣机、公共设备等共享资源的预约与使用。调整预约规则、使用限制、奖惩与监管，观察资源囤积、恶意预约、高峰垄断与分配不公如何涌现。',
  paramSchema: PARAM_SCHEMA, defaults: DEFAULTS, interventions: INTERVENTIONS, metricKeys: METRIC_KEYS, agentTypes: AGENT_TYPES,
  init, step, metrics, visualize, totalTicks, onParamChange, intervene, describe, liveCheck, detect,
};
