'use strict';
// 场景 2：团队协作实验室 —— 小组作业 / 社团项目 / 志愿者排班模拟
// 观察：刷分、逃避困难任务、工作量集中、搭便车、互评串通
const { gini, topShare, mean, pearson, clamp, percentile } = require('../metrics');

const id = 'team-collab';
const ROUND_TICKS = 10; // 每轮 10 个 tick：0 分配，1-8 工作，9 评分结算
const DIFF = { easy: { req: 6, label: '简单' }, med: { req: 12, label: '中等' }, hard: { req: 24, label: '困难' } };

const AGENT_TYPES = [
  { key: 'count-doer', arch: '实干者', label: '实干者', hint: '踏实肯干、主动承担难活的核心成员', def: 2 },
  { key: 'count-balanced', arch: '平衡者', label: '平衡者', hint: '按部就班完成分内工作的一般成员', def: 2 },
  { key: 'count-gamer', arch: '刷分者', label: '刷分者', hint: '善于包装贡献、钻评分漏洞的成员', def: 1 },
  { key: 'count-contributor', arch: '贡献者', label: '贡献者', hint: '能力与意愿双高、不计回报的成员', def: 2 },
  { key: 'count-freerider', arch: '搭便车者', label: '搭便车者', hint: '尽量少投入、搭顺风车的成员', def: 1 },
];

const BASE_PARAMS = [
  { key: 'teams', label: '团队数量', unit: '个', type: 'number', min: 2, max: 12, step: 1, def: 6, group: '结构', hint: '参与协作的小组/团队总数' },
  { key: 'rounds', label: '项目轮数', unit: '轮', type: 'number', min: 3, max: 8, step: 1, def: 5, group: '时间', hint: '协作轮次；每轮 = 任务分配 → 工作 → 评分结算' },
  { key: 'tasksPerRound', label: '每轮任务数', unit: '个', type: 'number', min: 4, max: 12, step: 1, def: 7, group: '任务', hint: '每轮每个团队需要完成的任务总数（含简单/中等/困难）' },
  { key: 'effortBudget', label: '每人每轮精力', unit: '精力', type: 'number', min: 6, max: 20, step: 1, def: 14, group: '任务', hint: '每个成员每轮可投入的总工作量上限；任务完成度以「投入精力」为单位计量' },
  { key: 'assignment', label: '任务分配方式', type: 'select', def: 'self', options: [
    { v: 'self', l: '自主认领' }, { v: 'leader', l: '组长分配' }, { v: 'random', l: '随机分配' }, { v: 'auction', l: '认领竞拍' }], group: '规则', hint: '任务如何派发给成员' },
  { key: 'scoring', label: '贡献评分方式', type: 'select', def: 'selfReport', options: [
    { v: 'selfReport', l: '自我申报' }, { v: 'peerReview', l: '同伴互评' }, { v: 'quantitative', l: '量化计量' }, { v: 'hybrid', l: '混合评分' }], group: '规则', hint: '如何计算每个成员的贡献分' },
  { key: 'rewardModel', label: '奖励分配方式', type: 'select', def: 'proportional', options: [
    { v: 'equal', l: '平均分配' }, { v: 'proportional', l: '按贡献分配' }, { v: 'topK', l: '头部奖励' }], group: '规则', hint: '团队总奖励在成员间如何分配' },
  { key: 'peerReviewCount', label: '互评人数', unit: '人', type: 'number', min: 2, max: 5, step: 1, def: 3, group: '规则', hint: '同伴互评时，每位成员由多少位队友评分' },
  { key: 'auditChance', label: '申报审计概率', unit: '%', scale: 100, type: 'number', min: 0, max: 0.9, step: 0.05, def: 0.35, group: '监管', hint: '自我申报的贡献量被系统抽查核实的概率' },
  { key: 'difficultyBonus', label: '困难任务加分倍率', unit: '倍', type: 'number', min: 1, max: 2.5, step: 0.1, def: 1.5, group: '激励', hint: '困难任务基础得分乘以该倍率，用于激励认领硬活' },
  { key: 'invisibleWeight', label: '低可见任务权重', unit: '×', type: 'number', min: 0.2, max: 1, step: 0.05, def: 0.5, group: '激励', hint: '量化评分时，低可见任务的投入折算系数（高可见任务 = 1）' },
  { key: 'freeRideThreshold', label: '搭便车判定阈值', unit: '%', scale: 100, type: 'number', min: 0.1, max: 0.5, step: 0.05, def: 0.25, group: '惩罚', hint: '投入低于团队中位数该比例即判定为搭便车' },
  { key: 'penalty', label: '搭便车惩罚', unit: '积分', type: 'number', min: 0, max: 100, step: 5, def: 20, group: '惩罚', hint: '被判定搭便车/刷分时扣除的虚拟积分（本实验的虚拟变量，非真实扣款）' },
  { key: 'detection', label: '违规发现概率', unit: '%', scale: 100, type: 'number', min: 0, max: 1, step: 0.05, def: 0.3, group: '监管', hint: '搭便车等违规行为被系统判定的概率' },
];

const agentTypeParams = AGENT_TYPES.map(t => ({
  key: t.key, label: t.label, unit: '人/队', type: 'number', min: 0, max: 12, step: 1, def: t.def,
  group: '虚拟人物', hint: t.hint + '（每队人数，修改后需重置实验生效）',
}));

const PARAM_SCHEMA = BASE_PARAMS.concat(agentTypeParams);

const DEFAULTS = {};
for (const s of PARAM_SCHEMA) DEFAULTS[s.key] = s.def;

const INTERVENTIONS = [
  { action: 'memberLeave', label: '成员退出', desc: '随机一名成员退出团队（工作量冲击）' },
  { action: 'urgentTask', label: '紧急任务', desc: '随机团队追加高可见困难任务' },
  { action: 'auditSurge', label: '突击审计', desc: '本轮申报审计概率提升至 90%' },
  { action: 'hardBonus', label: '困难任务激励', desc: '本轮困难任务加分倍率临时提升至 2.0' },
];

const METRIC_KEYS = [
  { key: 'completionRate', label: '任务完成率', unit: '%', pct: true, dec: 1, better: 'high' },
  { key: 'effortGini', label: '工作量基尼', unit: '', dec: 3, better: 'low' },
  { key: 'scoreInflation', label: '分数膨胀', unit: '×', dec: 2, better: 'low' },
  { key: 'hardCompletion', label: '困难任务完成率', unit: '%', pct: true, dec: 1, better: 'high' },
  { key: 'rewardCorr', label: '贡献-奖励相关性', unit: '', dec: 2, better: 'high' },
];

const ARCH_TRAITS = {
  '实干者': { exploit: [0.05, 0.25], diligence: [0.7, 1.0], leadership: [0.3, 0.8], risk: [0.2, 0.5] },
  '平衡者': { exploit: [0.3, 0.55], diligence: [0.45, 0.8], leadership: [0.3, 0.7], risk: [0.3, 0.6] },
  '刷分者': { exploit: [0.7, 1.0], diligence: [0.35, 0.7], leadership: [0.25, 0.65], risk: [0.55, 0.95] },
  '贡献者': { exploit: [0.05, 0.2], diligence: [0.85, 1.0], leadership: [0.5, 1.0], risk: [0.15, 0.4] },
  '搭便车者': { exploit: [0.3, 0.55], diligence: [0.1, 0.3], leadership: [0.15, 0.45], risk: [0.35, 0.65] },
};

function makeAgent(i, team, arch, rng) {
  const t = ARCH_TRAITS[arch] || ARCH_TRAITS['平衡者'];
  const traits = {
    exploit: rng.range(t.exploit[0], t.exploit[1]),
    diligence: rng.range(t.diligence[0], t.diligence[1]),
    leadership: rng.range(t.leadership[0], t.leadership[1]),
    risk: rng.range(t.risk[0], t.risk[1]),
  };
  return {
    id: i, team, arch, traits,
    spentRound: 0, spentTotal: 0, tasksRound: [], score: 0, reward: 0, penaltyAcc: 0,
    claims: 0, caught: 0, departed: false, collusions: 0, brokenPromises: 0,
  };
}

function buildTypePool(sim) {
  const pool = [];
  for (const t of AGENT_TYPES) {
    const n = Math.max(0, Math.round(sim.params[t.key] || 0));
    for (let i = 0; i < n; i++) pool.push(t.arch);
  }
  if (!pool.length) for (const t of AGENT_TYPES) for (let i = 0; i < t.def; i++) pool.push(t.arch);
  return pool;
}

function init(sim) {
  const p = sim.params, rng = sim.rng;
  sim.agents = [];
  sim.teams = [];
  const perTeam = buildTypePool(sim);
  sim.params.teamSize = perTeam.length;
  let aid = 0;
  for (let ti = 0; ti < p.teams; ti++) {
    const members = [];
    const types = rng.shuffle(perTeam.slice());
    for (let mi = 0; mi < perTeam.length; mi++) {
      const a = makeAgent(aid++, ti, types[mi % types.length], rng);
      sim.agents.push(a); members.push(a);
    }
    const leader = members.slice().sort((x, y) => y.traits.leadership - x.traits.leadership)[0];
    sim.teams.push({ id: ti, members, leader, tasks: [], roundScore: 0, score: 0 });
  }
  sim.taskSeq = 1;
  sim.round = 0;
  sim.extraTasks = [];
  sim.stats = {
    tasksTotal: 0, tasksDone: 0, hardTotal: 0, hardDone: 0, qualitySum: 0,
    claimsSum: 0, spentSum: 0, collusions: 0, brokenPromises: 0, promises: 0,
    audits: 0, auditCaught: 0, freeRiders: 0, freeRidersInduced: 0, freeRideCaught: 0,
    effortByDiff: { easy: 0, med: 0, hard: 0 },
  };
  sim.overrides = [];
  sim._alertState = {};
}

function totalTicks(sim) { return sim.params.rounds * ROUND_TICKS; }

function spentOn(t) { let s = 0; for (const v of t.spent.values()) s += v; return s; }

function genTasks(sim, team) {
  const p = sim.params, rng = sim.rng, n = p.tasksPerRound;
  const defs = [];
  let hardCount = 0;
  for (let i = 0; i < n; i++) {
    const diff = i % 3 === 2 ? 'hard' : (i % 3 === 1 ? 'med' : 'easy');
    const vis = rng.chance(0.55) ? 'high' : 'low';
    defs.push({ diff, vis });
    if (diff === 'hard') hardCount++;
  }
  if (hardCount < 2 && n >= 5) defs[n - 1].diff = 'hard';
  return defs.map(d => {
    const req = DIFF[d.diff].req;
    const points = +(req * (d.vis === 'high' ? 1.25 : 0.75) * (d.diff === 'hard' ? p.difficultyBonus : 1)).toFixed(1);
    return {
      id: sim.taskSeq++, team: team.id, round: sim.round, diff: d.diff, req, vis: d.vis, points,
      maxMembers: d.diff === 'hard' ? 4 : 3, assignees: [], spent: new Map(), completed: false, quality: 0,
    };
  });
}

function ensureCoverage(sim, team) {
  const rng = sim.rng;
  for (const t of team.tasks) {
    if (t.assignees.length) continue;
    const pool = team.members.filter(m => !m.departed && m.tasksRound.length < 2);
    if (!pool.length) continue;
    const a = pool[rng.int(0, pool.length - 1)];
    t.assignees.push({ agent: a, promised: null });
    a.tasksRound.push(t);
  }
}

function assignSelf(sim, team) {
  const rng = sim.rng, p = sim.params;
  const order = rng.shuffle(team.members.filter(m => !m.departed).slice());
  for (const a of order) {
    let picks = 0;
    while (a.tasksRound.length < 2 && picks < 2) {
      let best = null, bestR = -1;
      for (const t of team.tasks) {
        if (t.assignees.length >= t.maxMembers) continue;
        if (t.assignees.some(x => x.agent === a)) continue;
        const ratio = t.points / t.req;
        const r = ratio
          * (t.vis === 'high' ? (a.traits.exploit > 0.5 ? 2.2 : 1.3) : 0.85)
          * (t.diff === 'hard' ? (a.traits.exploit > 0.6 ? (p.difficultyBonus > 1.8 ? 1.1 : 0.25) : 1.05) : 1)
          * (0.8 + rng.float() * 0.4);
        if (r > bestR) { bestR = r; best = t; }
      }
      if (!best) break;
      best.assignees.push({ agent: a, promised: null });
      a.tasksRound.push(best); picks++;
    }
  }
  ensureCoverage(sim, team);
}

function assignLeader(sim, team) {
  const rng = sim.rng;
  const members = team.members.filter(m => !m.departed);
  const leader = team.leader;
  if (leader.traits.exploit < 0.45) {
    // 公平型：按勤奋度轮流，先难后易
    const byDil = members.slice().sort((x, y) => y.traits.diligence - x.traits.diligence);
    const tasks = team.tasks.slice().sort((a, b) => b.req - a.req);
    let i = 0;
    for (const t of tasks) {
      const target = Math.min(2, t.maxMembers);
      let guard = 0;
      while (t.assignees.length < target && guard++ < 40) {
        const a = byDil[i++ % byDil.length];
        if (a.tasksRound.length >= 2 || t.assignees.some(x => x.agent === a)) continue;
        t.assignees.push({ agent: a, promised: null });
        a.tasksRound.push(t);
      }
    }
  } else {
    // 自利型领导：自己与盟友挑轻活高可见，硬活低可见推给别人
    const allies = members.filter(m => m.traits.exploit > 0.55);
    const easyVis = team.tasks.filter(t => t.diff !== 'hard' && t.vis === 'high');
    const rest = team.tasks.filter(t => !easyVis.includes(t));
    let idx = 0;
    for (const t of easyVis) {
      const a = allies.length ? allies[idx++ % allies.length] : members[rng.int(0, members.length - 1)];
      if (a.tasksRound.length < 2 && !t.assignees.some(x => x.agent === a)) {
        t.assignees.push({ agent: a, promised: null }); a.tasksRound.push(t);
      }
    }
    if (leader.tasksRound.length < 2 && easyVis.length) {
      const t = easyVis[0];
      if (!t.assignees.some(x => x.agent === leader)) { t.assignees.push({ agent: leader, promised: null }); leader.tasksRound.push(t); }
    }
    for (const t of rest) {
      const pool = members.filter(m => m.tasksRound.length < 2 && !t.assignees.some(x => x.agent === m));
      if (pool.length) {
        const a = pool[rng.int(0, pool.length - 1)];
        t.assignees.push({ agent: a, promised: null }); a.tasksRound.push(t);
      }
    }
  }
  ensureCoverage(sim, team);
}

function assignRandom(sim, team) {
  const rng = sim.rng;
  const members = team.members.filter(m => !m.departed);
  for (const t of team.tasks) {
    const target = Math.min(2, t.maxMembers);
    let guard = 0;
    while (t.assignees.length < target && guard++ < 50) {
      const a = members[rng.int(0, members.length - 1)];
      if (a.tasksRound.length >= 2 || t.assignees.some(x => x.agent === a)) continue;
      t.assignees.push({ agent: a, promised: null }); a.tasksRound.push(t);
    }
  }
  ensureCoverage(sim, team);
}

function assignAuction(sim, team) {
  const rng = sim.rng, p = sim.params;
  const members = team.members.filter(m => !m.departed);
  const tasks = team.tasks.slice().sort((a, b) => b.points - a.points);
  for (const t of tasks) {
    const bids = members
      .filter(m => m.tasksRound.length < 2 && !t.assignees.some(x => x.agent === m))
      .map(m => ({ m, bid: Math.min(p.effortBudget * 0.6, (t.req / t.maxMembers) * (0.7 + rng.float() * 0.6 + m.traits.exploit * 0.6)) }))
      .sort((a, b) => b.bid - a.bid);
    const winners = bids.slice(0, Math.max(1, Math.min(t.maxMembers, bids.length)));
    for (const w of winners) {
      t.assignees.push({ agent: w.m, promised: +w.bid.toFixed(1) });
      w.m.tasksRound.push(t);
      if (w.bid > (t.req / t.maxMembers) * 1.5) sim.stats.promises++;
    }
  }
  ensureCoverage(sim, team);
}

function assignRound(sim) {
  sim.round = Math.floor(sim.tick / ROUND_TICKS);
  const p = sim.params;
  for (const team of sim.teams) {
    for (const a of team.members) { a.spentRound = 0; a.tasksRound = []; }
    team.tasks = [];
    // 消费追加的紧急任务
    const extra = sim.extraTasks.filter(e => e.team === team.id);
    sim.extraTasks = sim.extraTasks.filter(e => e.team !== team.id);
    for (const e of extra) {
      const req = DIFF.hard.req;
      team.tasks.push({
        id: sim.taskSeq++, team: team.id, round: sim.round, diff: 'hard', req, vis: 'high',
        points: +(req * 1.25 * p.difficultyBonus).toFixed(1), maxMembers: 4, assignees: [], spent: new Map(), completed: false, quality: 0, urgent: true,
      });
    }
    team.tasks.push(...genTasks(sim, team));
    if (p.assignment === 'self') assignSelf(sim, team);
    else if (p.assignment === 'leader') assignLeader(sim, team);
    else if (p.assignment === 'random') assignRandom(sim, team);
    else assignAuction(sim, team);
  }
}

function workTick(sim) {
  const p = sim.params, rng = sim.rng;
  for (const team of sim.teams) {
    for (const a of team.members) {
      if (a.departed) continue;
      let left = p.effortBudget - a.spentRound;
      if (left <= 0 || !a.tasksRound.length) continue;
      const ts = a.tasksRound.slice().sort((t1, t2) => {
        if (a.traits.exploit > 0.6) return ((t2.vis === 'high') - (t1.vis === 'high')) || (t1.req - t2.req);
        return t2.req - t1.req; // 实干者先啃硬骨头
      });
      for (const t of ts) {
        const remaining = Math.max(0, t.req - spentOn(t));
        if (remaining <= 0.01) continue;
        const share = t.req / t.assignees.length;
        let factor;
        if (a.arch === '搭便车者') factor = 0.05 + rng.float() * 0.15;
        else if (a.traits.exploit > 0.6) {
          factor = t.vis === 'high' ? 0.6 + rng.float() * 0.4 : 0.15 + rng.float() * 0.2;
          if (t.diff === 'hard') factor *= 0.6;
        } else {
          factor = clamp(a.traits.diligence * (0.8 + rng.float() * 0.5), 0.2, 1.3);
        }
        // 制度激励：平均奖励助长偷懒；按贡献分配 + 高监管 + 量化评分抑制
        if (a.arch !== '实干者' && a.arch !== '贡献者') {
          let incentive = 1;
          if (p.rewardModel === 'equal') incentive = 0.35;
          else if (p.rewardModel === 'proportional') incentive = clamp(0.75 + p.detection * 0.9, 0.75, 1.5);
          if (p.scoring === 'quantitative' || p.scoring === 'hybrid') incentive *= 1.1;
          factor = Math.max(0.05, Math.min(1.3, factor * incentive));
        }
        const spend = Math.max(0, Math.min(share * factor, left, remaining));
        if (spend <= 0) continue;
        t.spent.set(a.id, (t.spent.get(a.id) || 0) + spend);
        a.spentRound += spend; a.spentTotal += spend;
        sim.stats.effortByDiff[t.diff] += spend;
        left -= spend;
      }
    }
  }
}

function computeShares(sim, team, t, spentTotal) {
  const p = sim.params, rng = sim.rng;
  const list = t.assignees.map(x => x.agent).filter(a => !a.departed);
  if (!list.length) return [];
  const spentOf = a => t.spent.get(a.id) || 0;

  if (p.scoring === 'quantitative') {
    const visW = t.vis === 'high' ? 1 : p.invisibleWeight;
    for (const a of list) { sim.stats.claimsSum += spentOf(a); sim.stats.spentSum += spentOf(a); }
    return list.map(a => ({ agent: a, share: (spentOf(a) / spentTotal) * visW, claimed: spentOf(a) }));
  }

  if (p.scoring === 'selfReport') {
    const claims = list.map(a => {
      const base = spentOf(a);
      const inflate = a.traits.exploit > 0.4 ? a.traits.exploit * (0.35 + 1.0 * rng.float()) * (1 - p.auditChance * 1.2) : 0.05 * rng.float();
      return { agent: a, claim: base * (1 + inflate), true: base };
    });
    for (const c of claims) {
      sim.stats.audits++;
      if (rng.chance(p.auditChance) && c.claim > 1.3 * c.true) {
        c.agent.caught++; c.agent.penaltyAcc += p.penalty; sim.stats.auditCaught++;
        sim.log('audit-catch', { agent: c.agent.id, arch: c.agent.arch, team: t.team, claimed: +c.claim.toFixed(1), true: +c.true.toFixed(1), penalty: p.penalty });
        c.claim = c.true;
      }
    }
    const sumC = claims.reduce((x, c) => x + c.claim, 0) || 1;
    for (const c of claims) { c.agent.claims += c.claim; sim.stats.claimsSum += c.claim; sim.stats.spentSum += c.true; }
    return claims.map(c => ({ agent: c.agent, share: c.claim / sumC, claimed: c.claim }));
  }

  // peerReview / hybrid
  const ratings = list.map(a => {
    const reviewers = rng.shuffle(team.members.filter(m => !m.departed && m !== a).slice()).slice(0, p.peerReviewCount);
    let sum = 0;
    for (const r of reviewers) {
      let rating = spentOf(a) * (0.7 + 0.6 * rng.float());
      if (r.traits.exploit > 0.6 && a.traits.exploit > 0.6 && rng.chance(0.45)) {
        rating *= 1.7; a.collusions++; r.collusions++; sim.stats.collusions++;
        sim.log('collusion-review', { agent: a.id, reviewer: r.id, team: t.team, rating: +rating.toFixed(1), true: +spentOf(a).toFixed(1) });
      }
      sum += rating;
    }
    return { agent: a, rating: sum / Math.max(1, reviewers.length), true: spentOf(a) };
  });
  const peerShares = ratings.map(r => ({ agent: r.agent, share: r.rating }));
  const sumR = peerShares.reduce((x, s) => x + s.share, 0) || 1;
  for (const s of peerShares) s.share /= sumR;
  for (const r of ratings) { sim.stats.claimsSum += r.rating; sim.stats.spentSum += r.true; }
  if (p.scoring === 'peerReview') return peerShares.map(s => ({ agent: s.agent, share: s.share, claimed: s.share * spentTotal }));
  const quant = list.map(a => ({ agent: a, share: spentOf(a) / spentTotal }));
  return quant.map(q => {
    const pr = peerShares.find(s => s.agent === q.agent);
    return { agent: q.agent, share: (q.share + (pr ? pr.share : 0)) / 2, claimed: q.share * spentTotal };
  });
}

function detectFreeRiders(sim, team) {
  const p = sim.params, rng = sim.rng;
  const members = team.members.filter(m => !m.departed);
  const efforts = members.map(a => a.spentRound);
  const med = percentile(efforts, 0.5);
  for (const a of members) {
    if (a.spentRound < p.freeRideThreshold * Math.max(0.5, med)) {
      sim.stats.freeRiders++;
      if (a.arch !== '搭便车者') sim.stats.freeRidersInduced++; // 制度诱导型（非天生懒）
      if (rng.chance(p.detection)) {
        a.caught++; a.penaltyAcc += p.penalty; sim.stats.freeRideCaught++;
        sim.log('free-ride-caught', { agent: a.id, arch: a.arch, team: team.id, effort: +a.spentRound.toFixed(1), median: +med.toFixed(1), penalty: p.penalty });
      }
    }
  }
}

function distributeReward(sim, team, pot) {
  const p = sim.params;
  const members = team.members.filter(m => !m.departed);
  if (!members.length || pot <= 0) return;
  if (p.rewardModel === 'equal') {
    for (const a of members) a.reward += pot / members.length;
  } else if (p.rewardModel === 'proportional') {
    const tot = members.reduce((x, a) => x + a.score, 0) || 1;
    for (const a of members) a.reward += pot * a.score / tot;
  } else {
    const sorted = members.slice().sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, Math.min(3, sorted.length));
    const rest = sorted.slice(top.length);
    for (const a of top) a.reward += pot * 0.4 / top.length;
    if (rest.length) for (const a of rest) a.reward += pot * 0.6 / rest.length;
  }
  for (const a of members) {
    if (a.penaltyAcc > 0) { a.reward = Math.max(0, a.reward - a.penaltyAcc); a.penaltyAcc = 0; }
  }
}

function scoreRound(sim) {
  const p = sim.params;
  for (const team of sim.teams) {
    let roundScore = 0;
    for (const t of team.tasks) {
      const st = spentOn(t);
      t.completed = st >= t.req;
      t.quality = t.completed ? clamp(st / t.req, 0, 1.25) : 0;
      sim.stats.tasksTotal++;
      if (t.diff === 'hard') { sim.stats.hardTotal++; if (t.completed) sim.stats.hardDone++; }
      if (t.completed) {
        sim.stats.tasksDone++;
        sim.stats.qualitySum += t.quality;
        roundScore += t.points * t.quality;
        const shares = computeShares(sim, team, t, st);
        for (const s of shares) s.agent.score += t.points * t.quality * s.share;
      } else {
        sim.log('task-failed', { team: team.id, task: t.id, diff: t.diff, vis: t.vis, req: t.req, spent: +st.toFixed(1) });
      }
      if (p.assignment === 'auction') {
        for (const x of t.assignees) {
          if (x.promised != null && (t.spent.get(x.agent.id) || 0) < 0.5 * x.promised) {
            x.agent.brokenPromises++; sim.stats.brokenPromises++;
            sim.log('broken-promise', { agent: x.agent.id, team: t.team, task: t.id, promised: x.promised, spent: +(t.spent.get(x.agent.id) || 0).toFixed(1) });
          }
        }
      }
    }
    team.roundScore = roundScore;
    team.score += roundScore;
    detectFreeRiders(sim, team);
    distributeReward(sim, team, roundScore);
  }
}

function step(sim) {
  sim.overrides = sim.overrides.filter(o => {
    if (o.until <= sim.tick) { sim.params[o.key] = o.orig; return false; }
    return true;
  });
  const phase = sim.tick % ROUND_TICKS;
  if (phase === 0) assignRound(sim);
  else if (phase >= 1 && phase <= 8) workTick(sim);
  else scoreRound(sim);
}

function metrics(sim) {
  const s = sim.stats;
  const agents = sim.agents.filter(a => !a.departed);
  const roundsElapsed = Math.max(1, Math.floor(sim.tick / ROUND_TICKS));
  const totalEffort = agents.reduce((x, a) => x + a.spentTotal, 0) || 1;
  const easyShare = s.effortByDiff.easy / totalEffort;
  return {
    round: sim.round,
    completionRate: s.tasksTotal ? +(s.tasksDone / s.tasksTotal).toFixed(3) : 1,
    avgQuality: s.tasksDone ? +(s.qualitySum / s.tasksDone).toFixed(3) : 1,
    effortGini: +gini(agents.map(a => a.spentTotal)).toFixed(3),
    scoreInflation: s.spentSum ? +(s.claimsSum / s.spentSum).toFixed(3) : 1,
    freeRiderRate: +(s.freeRiders / Math.max(1, agents.length * roundsElapsed)).toFixed(3),
    freeRiderInducedRate: +(s.freeRidersInduced / Math.max(1, agents.length * roundsElapsed)).toFixed(3),
    hardCompletion: s.hardTotal ? +(s.hardDone / s.hardTotal).toFixed(3) : 1,
    easyLoad: +easyShare.toFixed(3),
    rewardCorr: +pearson(agents.map(a => a.spentTotal), agents.map(a => a.reward)).toFixed(3),
    teamOutput: +mean(sim.teams.map(t => t.score)).toFixed(1),
  };
}

function visualize(sim) {
  return {
    round: sim.round,
    phase: sim.tick % ROUND_TICKS,
    teams: sim.teams.map(tm => ({
      id: tm.id, score: +tm.score.toFixed(1), roundScore: +tm.roundScore.toFixed(1), leader: tm.leader.id,
      tasks: tm.tasks.map(t => ({
        id: t.id, diff: t.diff, vis: t.vis, req: t.req, points: t.points, urgent: !!t.urgent,
        spent: +spentOn(t).toFixed(1), completed: t.completed, quality: +t.quality.toFixed(2), n: t.assignees.length,
      })),
      members: tm.members.map(a => ({
        id: a.id, arch: a.arch, departed: a.departed,
        effort: +a.spentRound.toFixed(1), total: +a.spentTotal.toFixed(1),
        score: +a.score.toFixed(1), reward: +a.reward.toFixed(1),
        exploit: +a.traits.exploit.toFixed(2), caught: a.caught,
      })),
    })),
    stats: sim.stats,
  };
}

function intervene(sim, action) {
  const rng = sim.rng, t = sim.tick;
  if (action === 'memberLeave') {
    const pool = sim.agents.filter(a => !a.departed);
    if (!pool.length) return;
    const a = rng.pick(pool);
    a.departed = true;
    sim.log('member-leave', { agent: a.id, arch: a.arch, team: a.team, msg: `成员 #${a.id}（${a.arch}）退出团队 ${a.team}` });
  } else if (action === 'urgentTask') {
    const tid = rng.int(0, sim.params.teams - 1);
    sim.extraTasks.push({ team: tid });
    sim.log('intervene', { action, msg: `团队 ${tid} 追加一件高可见困难任务` });
  } else if (action === 'auditSurge') {
    const until = t + (ROUND_TICKS - t % ROUND_TICKS);
    sim.overrides.push({ key: 'auditChance', orig: sim.params.auditChance, until });
    sim.params.auditChance = 0.9;
    sim.log('intervene', { action, msg: '突击审计：本轮申报审计概率提升至 90%' });
  } else if (action === 'hardBonus') {
    const until = t + (ROUND_TICKS - t % ROUND_TICKS) + ROUND_TICKS;
    sim.overrides.push({ key: 'difficultyBonus', orig: sim.params.difficultyBonus, until });
    sim.params.difficultyBonus = 2.0;
    sim.log('intervene', { action, msg: '困难任务激励：本轮加分倍率临时提升至 2.0' });
  }
}

function describe(ev) {
  const d = DIFF[ev.diff];
  switch (ev.type) {
    case 'task-failed': return `团队 ${ev.team} 的任务 #${ev.task}（${d ? d.label : ev.diff}）烂尾：投入 ${ev.spent}/${ev.req}`;
    case 'audit-catch': return `成员 #${ev.agent}（${ev.arch}）自我申报 ${ev.claimed} 被审计抓包，真实投入 ${ev.true}，扣罚 ${ev.penalty}`;
    case 'collusion-review': return `成员 #${ev.agent} 与 #${ev.reviewer} 互评串通，评分 ${ev.rating}（真实投入 ${ev.true}）`;
    case 'broken-promise': return `成员 #${ev.agent} 竞拍承诺 ${ev.promised}，实际投入仅 ${ev.spent}`;
    case 'free-ride-caught': return `成员 #${ev.agent}（${ev.arch}）本轮投入 ${ev.effort}，低于团队中位数 ${ev.median}，被判定搭便车并扣罚 ${ev.penalty}`;
    case 'member-leave': return ev.msg;
    case 'intervene': return `外部干预：${ev.msg}`;
    case 'param-change': return `规则修改：${ev.label} ${JSON.stringify(ev.from)} → ${JSON.stringify(ev.to)}`;
    case 'redteam-alert': return `[红队警报] ${ev.msg}`;
    default: return ev.type;
  }
}

function liveCheck(sim) {
  const st = sim._alertState || (sim._alertState = {});
  const t = sim.tick, out = [];
  const cool = (k, cd) => { if (st[k] && t - st[k] < cd) return false; st[k] = t; return true; };
  const p = sim.params, s = sim.stats;
  const infl = s.spentSum > 0 ? s.claimsSum / s.spentSum : 1;
  if (p.scoring === 'selfReport' && infl > 1.22 && cool('infl', 12)) {
    out.push({ pattern: 'score-farming', msg: `红队发现：自我申报分数膨胀 ${infl.toFixed(2)}×，疑似刷分` });
  }
  if (s.collusions >= 2 && cool('coll', 12)) out.push({ pattern: 'collusion', msg: `红队发现：已检测到 ${s.collusions} 次互评串通` });
  if (sim.round >= 2) {
    const hc = s.hardTotal ? s.hardDone / s.hardTotal : 1;
    if (hc < 0.5 && cool('hard', 12)) out.push({ pattern: 'hard-evasion', msg: `红队发现：困难任务完成率仅 ${(hc * 100).toFixed(0)}%` });
  }
  const fr = s.freeRiders / Math.max(1, sim.agents.filter(a => !a.departed).length * Math.max(1, sim.round));
  if (fr > 0.18 && cool('fr', 12)) out.push({ pattern: 'free-riding', msg: `红队发现：搭便车比例 ${(fr * 100).toFixed(0)}%` });
  const g = gini(sim.agents.filter(a => !a.departed).map(a => a.spentTotal));
  if (g > 0.4 && cool('gini', 12)) out.push({ pattern: 'workload-concentration', msg: `红队发现：工作量基尼 ${g.toFixed(2)}，负载集中在少数人身上` });
  return out;
}

function evidence(sim, types, agentIds, limit) {
  const set = new Set(agentIds || []);
  return sim.events
    .filter(e => types.includes(e.type) && (e.agent == null || set.has(e.agent)))
    .slice(-(limit || 8))
    .map(e => ({ tick: e.tick, agent: e.agent, text: describe(e) }));
}

function detect(sim) {
  const p = sim.params, agents = sim.agents.filter(a => !a.departed), s = sim.stats, out = [];
  // 实验早期（尚未完成至少一轮评分）不做结论，避免零投入误报
  if (s.tasksTotal < sim.params.tasksPerRound) return out;
  const infl = s.spentSum > 0 ? s.claimsSum / s.spentSum : 1;
  const efforts = agents.map(a => a.spentTotal);
  const g = gini(efforts);
  const rounds = Math.max(1, sim.round);
  const fr = s.freeRiders / Math.max(1, agents.length * rounds);
  const hardC = s.hardTotal ? s.hardDone / s.hardTotal : 1;
  const totalEffort = efforts.reduce((x, y) => x + y, 0) || 1;
  const easyLoad = s.effortByDiff.easy / totalEffort;
  const byRatio = agents.slice().sort((a, b) => (b.claims / Math.max(0.1, b.spentTotal)) - (a.claims / Math.max(0.1, a.spentTotal)));
  const worstIds = byRatio.slice(0, 5).map(a => a.id);
  const worstColluders = agents.slice().sort((a, b) => b.collusions - a.collusions).slice(0, 5).map(a => a.id);
  const worstFreeRide = agents.slice().sort((a, b) => a.spentTotal - b.spentTotal).slice(0, 5).map(a => a.id);
  const worstBroken = agents.slice().sort((a, b) => b.brokenPromises - a.brokenPromises).slice(0, 5).map(a => a.id);

  if (p.scoring === 'selfReport' && infl > 1.10) {
    out.push({
      pattern: 'score-farming', name: '自我申报刷分', severity: infl > 1.35 ? 'high' : 'medium',
      why: `采用"自我申报"评分且审计概率仅 ${p.auditChance}。申报分数/真实投入 = ${infl.toFixed(2)}×，刷分者低投入高申报，诚实者反而吃亏。`,
      trigger: { key: 'scoring', label: '贡献评分方式', value: p.scoring },
      evidence: evidence(sim, ['audit-catch'], worstIds),
      impact: { metric: '分数膨胀倍数', value: +infl.toFixed(2), text: `申报分数是真实投入的 ${infl.toFixed(2)} 倍，审计共抓包 ${s.auditCaught} 次` },
      fix: { key: 'scoring', value: 'hybrid', rationale: '改为"混合评分"（量化计量 + 互评各半），或把审计概率提高到 0.4 以上' },
    });
  }

  if (s.collusions >= 2 && (p.scoring === 'peerReview' || p.scoring === 'hybrid')) {
    out.push({
      pattern: 'collusion', name: '互评串通 / 联盟互刷', severity: s.collusions >= 5 ? 'high' : 'medium',
      why: `互评人数仅 ${p.peerReviewCount}，高钻营倾向个体形成小圈子互相打高分（检测到 ${s.collusions} 次串通评分）。`,
      trigger: { key: 'peerReviewCount', label: '互评人数', value: p.peerReviewCount },
      evidence: evidence(sim, ['collusion-review'], worstColluders),
      impact: { metric: '串通评分次数', value: s.collusions, text: `互评信号被污染，${s.collusions} 次互相抬高评分` },
      fix: { key: 'peerReviewCount', value: 5, rationale: '互评人数增加到 5 人并启用混合评分，小圈子难以操控整体评分' },
    });
  }

  if (hardC < 0.6) {
    out.push({
      pattern: 'hard-evasion', name: '困难任务逃避', severity: hardC < 0.4 ? 'high' : 'medium',
      why: `困难任务完成率仅 ${(hardC * 100).toFixed(0)}%。${p.assignment === 'self' ? '自主认领' : p.assignment === 'auction' ? '竞拍认领' : '当前分配方式'} + 困难加分倍率 ${p.difficultyBonus} 下，理性个体都挑轻活，硬骨头无人碰。`,
      trigger: { key: 'assignment', label: '任务分配方式', value: p.assignment },
      evidence: evidence(sim, ['task-failed'], agents.filter(a => a.traits.exploit > 0.6).slice(0, 5).map(a => a.id)),
      impact: { metric: '困难任务完成率', value: +hardC.toFixed(2), text: `${s.hardTotal - s.hardDone} 个困难任务烂尾，团队产出受损` },
      fix: { key: 'difficultyBonus', value: 2.0, rationale: '困难任务加分倍率提高到 2.0，或改为组长分配强制摊派硬任务' },
    });
  }

  if (g > 0.32) {
    out.push({
      pattern: 'workload-concentration', name: '工作量集中 / 骨干过载', severity: g > 0.45 ? 'high' : 'medium',
      why: `个人累计投入的基尼系数 ${g.toFixed(2)}。少数实干者承担大部分工作，长期将过劳退出；搭便车者零投入却分享团队奖励。`,
      trigger: { key: 'freeRideThreshold', label: '搭便车判定阈值', value: p.freeRideThreshold },
      evidence: evidence(sim, ['free-ride-caught'], worstFreeRide),
      impact: { metric: '工作量基尼系数', value: +g.toFixed(2), text: `基尼 ${g.toFixed(2)}，搭便车者占比 ${(fr * 100).toFixed(0)}%` },
      fix: { key: 'penalty', value: 50, rationale: '搭便车惩罚提高到 50，判定阈值降到 0.25，配合互评让搭便车无利可图' },
    });
  }

  // 制度诱导搭便车：以实干者/贡献者的中位累计投入为参照（他们不受奖励规则影响），
  // 排除天生搭便车型人格后，仍有显著比例成员投入不足 → 说明制度本身在诱导偷懒
  const diligent = agents.filter(a => a.arch === '实干者' || a.arch === '贡献者');
  const medRef = percentile(diligent.map(a => a.spentTotal), 0.5);
  const induced = agents.filter(a => !a.departed && a.arch !== '搭便车者' && a.spentTotal < p.freeRideThreshold * 1.2 * Math.max(1, medRef)).length;
  const frI = induced / Math.max(1, agents.length);
  if (frI > 0.04) {
    out.push({
      pattern: 'free-riding', name: '制度诱导搭便车 / 威慑不足', severity: frI > 0.12 ? 'high' : 'medium',
      why: `以实干者/贡献者的中位投入为参照，仍有 ${(frI * 100).toFixed(0)}% 的非天生搭便车者投入不足参照的 ${(p.freeRideThreshold * 120).toFixed(0)}%。${p.rewardModel === 'equal' ? '平均分配奖励让努力与回报脱钩，理性个体选择最小投入。' : ''}${p.detection < 0.2 ? '违规发现概率仅 ' + p.detection + '，搭便车几乎无成本。' : ''}`,
      trigger: { key: p.rewardModel === 'equal' ? 'rewardModel' : 'detection', label: p.rewardModel === 'equal' ? '奖励分配方式' : '违规发现概率', value: p.rewardModel === 'equal' ? p.rewardModel : p.detection },
      evidence: evidence(sim, ['free-ride-caught'], worstFreeRide),
      impact: { metric: '制度诱导搭便车比例', value: +frI.toFixed(2), text: `${induced} 名成员（排除天生搭便车型人格）投入不足，团队产能被侵蚀` },
      fix: { key: 'rewardModel', value: 'proportional', rationale: '奖励按贡献分配使努力与回报挂钩；搭便车惩罚提高到 40 以上、发现概率 0.5 以上形成威慑' },
    });
  }

  const completion = s.tasksTotal ? s.tasksDone / s.tasksTotal : 1;
  if (completion < 0.55 && (p.rewardModel === 'equal' || p.detection < 0.2)) {
    out.push({
      pattern: 'task-failure', name: '制度性低效 / 任务烂尾', severity: completion < 0.45 ? 'high' : 'medium',
      why: `任务完成率仅 ${(completion * 100).toFixed(0)}%。${p.rewardModel === 'equal' ? '平均奖励让努力与回报脱钩，理性个体选择最小投入。' : '监管缺位下搭便车蔓延，团队产能被侵蚀。'}`,
      trigger: { key: p.rewardModel === 'equal' ? 'rewardModel' : 'detection', label: p.rewardModel === 'equal' ? '奖励分配方式' : '违规发现概率', value: p.rewardModel === 'equal' ? p.rewardModel : p.detection },
      evidence: evidence(sim, ['task-failed'], []),
      impact: { metric: '任务完成率', value: +completion.toFixed(2), text: `${s.tasksTotal - s.tasksDone} 个任务烂尾，团队总产出受损` },
      fix: { key: 'rewardModel', value: 'proportional', rationale: '改为按贡献分配奖励使努力与回报挂钩；若已按贡献分配，请提高违规发现概率与搭便车惩罚' },
    });
  }

  const corr = pearson(agents.map(a => a.spentTotal), agents.map(a => a.reward));
  if (p.rewardModel === 'equal' && corr < 0.35) {
    out.push({
      pattern: 'reward-decoupling', name: '贡献与奖励脱钩', severity: 'medium',
      why: `平均分配下，贡献-奖励相关性仅 ${corr.toFixed(2)}。实干者的额外投入得不到回报，长期将退化为"按最低标准交付"。`,
      trigger: { key: 'rewardModel', label: '奖励分配方式', value: p.rewardModel },
      evidence: evidence(sim, ['free-ride-caught'], worstFreeRide),
      impact: { metric: '贡献-奖励相关性', value: +corr.toFixed(2), text: '高贡献者与低贡献者获得几乎相同的奖励' },
      fix: { key: 'rewardModel', value: 'proportional', rationale: '按贡献分配奖励，或引入头部奖励（topK）激励高贡献者' },
    });
  }

  if (p.assignment === 'auction' && s.brokenPromises > 0) {
    out.push({
      pattern: 'overpromise', name: '竞拍过度承诺', severity: 'medium',
      why: `认领竞拍机制下，个体靠夸大承诺抢任务（检测到 ${s.brokenPromises} 次承诺未兑现），实际投入不足。`,
      trigger: { key: 'assignment', label: '任务分配方式', value: p.assignment },
      evidence: evidence(sim, ['broken-promise'], worstBroken),
      impact: { metric: '违约承诺次数', value: s.brokenPromises, text: `${s.brokenPromises} 次高承诺低交付` },
      fix: { key: 'assignment', value: 'leader', rationale: '改为组长分配，或对竞拍承诺引入违约扣分机制' },
    });
  }

  if (p.scoring === 'quantitative' && easyLoad > 0.55) {
    out.push({
      pattern: 'invisible-work', name: '低可见工作荒废', severity: 'low',
      why: `量化评分给低可见任务仅 ${p.invisibleWeight} 权重，成员扎堆简单可见任务（简单任务占 ${(easyLoad * 100).toFixed(0)}% 投入），琐碎但必要的工作无人做。`,
      trigger: { key: 'invisibleWeight', label: '低可见任务权重', value: p.invisibleWeight },
      evidence: evidence(sim, ['task-failed'], []),
      impact: { metric: '简单任务投入占比', value: +easyLoad.toFixed(2), text: `${(easyLoad * 100).toFixed(0)}% 的精力投在简单任务上` },
      fix: { key: 'invisibleWeight', value: 0.85, rationale: '把低可见任务权重提到 0.85 以上，或由组长强制分配隐形工作' },
    });
  }

  return out;
}

module.exports = {
  id, name: '团队协作实验室', tagline: '小组作业 · 社团项目 · 志愿者排班', kernel: 'team-collab', resourceName: '',
  description: '模拟大学小组作业、社团项目与志愿者排班。设计任务分配、贡献评分与奖励制度，观察刷分、逃避困难任务、工作量集中与搭便车如何涌现。',
  paramSchema: PARAM_SCHEMA, defaults: DEFAULTS, interventions: INTERVENTIONS, metricKeys: METRIC_KEYS, agentTypes: AGENT_TYPES,
  init, step, metrics, visualize, totalTicks, intervene, describe, liveCheck, detect,
};
