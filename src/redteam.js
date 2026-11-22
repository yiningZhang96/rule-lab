'use strict';
// 红队模块：汇总场景漏洞检测结果，生成可追溯的漏洞报告
const SEV_W = { high: 18, medium: 9, low: 4 };
const SEV_LABEL = { high: '严重', medium: '中等', low: '轻微' };

function labeledParams(sim) {
  const out = {};
  for (const s of sim.scenario.paramSchema) out[s.key] = { label: s.label, value: sim.params[s.key] };
  return out;
}

function buildReport(rec) {
  const sim = rec.sim;
  const labelOf = {};
  for (const s of sim.scenario.paramSchema) labelOf[s.key] = s.label;
  const vulns = sim.scenario.detect(sim)
    .map(v => {
      if (v.trigger && labelOf[v.trigger.key]) v.trigger.label = labelOf[v.trigger.key];
      if (v.fix && labelOf[v.fix.key]) v.fix.label = labelOf[v.fix.key];
      return v;
    })
    .sort((a, b) => (SEV_W[b.severity] || 0) - (SEV_W[a.severity] || 0));
  const final = sim.latestMetrics();
  let health = 100;
  for (const v of vulns) health -= SEV_W[v.severity] || 5;
  // 指标层面的额外扣分
  if (final.gini != null && final.gini > 0.4) health -= 6;
  if (final.utilization != null && final.utilization < 0.4) health -= 4;
  health = Math.max(5, Math.round(health));
  return {
    simId: rec.id,
    scenarioId: sim.scenario.id,
    scenarioName: sim.scenario.name,
    resourceName: sim.resourceName || '',
    scenarioDef: {
      id: sim.scenario.id,
      kernel: sim.scenario.kernel || sim.scenario.id,
      builtin: sim.scenario.builtin !== false,
      name: sim.scenario.name,
      tagline: sim.scenario.tagline || '',
      description: sim.scenario.description || '',
      resourceName: sim.resourceName || '',
      paramSchema: sim.scenario.paramSchema,
      metricKeys: sim.scenario.metricKeys,
      agentTypes: sim.scenario.agentTypes || [],
      interventions: sim.scenario.interventions || [],
    },
    seed: sim.seed,
    ticks: sim.tick,
    totalTicks: sim.scenario.totalTicks(sim),
    completed: sim.done,
    params: labeledParams(sim),
    ruleLog: sim.ruleLog,
    metrics: final,
    metricKeys: sim.scenario.metricKeys,
    health,
    vulnerabilityCount: vulns.length,
    vulnerabilities: vulns.map((v, i) => ({
      no: i + 1, pattern: v.pattern, name: v.name, severity: v.severity,
      severityLabel: SEV_LABEL[v.severity] || v.severity,
      why: v.why, trigger: v.trigger, evidence: v.evidence, impact: v.impact, fix: v.fix,
    })),
    generatedAt: new Date().toISOString(),
    eventCount: sim.events.length,
  };
}

// 对比两次实验（A/B）
function compare(recA, recB) {
  const A = recA.sim.latestMetrics(), B = recB.sim.latestMetrics();
  const rows = (recA.sim.scenario.metricKeys || []).map(k => ({
    key: k.key, label: k.label, better: k.better,
    a: A[k.key], b: B[k.key],
    delta: (A[k.key] != null && B[k.key] != null) ? +(B[k.key] - A[k.key]).toFixed(3) : null,
  }));
  return {
    a: { simId: recA.id, seed: recA.sim.seed, ticks: recA.sim.tick, params: labeledParams(recA.sim) },
    b: { simId: recB.id, seed: recB.sim.seed, ticks: recB.sim.tick, params: labeledParams(recB.sim) },
    rows,
  };
}

module.exports = { buildReport, compare };
