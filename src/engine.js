'use strict';
// 模拟引擎核心：管理 tick 循环、事件日志（可追溯）、规则修改记录
const { Rng } = require('./rng');

const MAX_EVENTS = 6000;

class Simulation {
  /**
   * @param scenario 场景定义（见 src/scenarios/*）
   * @param params   用户规则参数（会覆盖场景默认值）
   * @param seed     随机种子（相同种子 → 完全可复现）
   */
  constructor(scenario, params, seed) {
    this.scenario = scenario;
    this.id = null;
    this.resourceName = scenario.resourceName || '';
    this.seed = (seed == null ? (Math.random() * 1e9) | 0 : seed) >>> 0;
    this.rng = new Rng(this.seed);
    this.params = Object.assign({}, scenario.defaults, params || {});
    this.tick = 0;
    this.agents = [];
    this.events = [];      // 事件日志（漏洞报告的证据来源）
    this.history = [];     // 指标时间序列
    this.done = false;
    this.ruleLog = [];     // 规则修改/干预记录（可追溯）
    this._seq = 0;
    scenario.init(this);
  }

  log(type, data) {
    this.events.push(Object.assign({ seq: ++this._seq, tick: this.tick, type }, data || {}));
    if (this.events.length > MAX_EVENTS) this.events.splice(0, 1000);
  }

  noteRule(text) { this.ruleLog.push({ tick: this.tick, text }); }

  // 运行中实时修改规则（制度压力测试的关键：中途改规则看群体反应）
  setParam(key, value, label) {
    const old = this.params[key];
    this.params[key] = value;
    this.noteRule(`修改规则：${label || key}：${JSON.stringify(old)} → ${JSON.stringify(value)}`);
    this.log('param-change', { key, label: label || key, from: old, to: value });
    if (this.scenario.onParamChange) this.scenario.onParamChange(this, key, value, old);
  }

  step() {
    if (this.done) return;
    this.scenario.step(this);
    this.tick++;
    const m = this.scenario.metrics(this);
    this.history.push(Object.assign({ tick: this.tick }, m));
    if (this.history.length > 4000) this.history.shift();
    if (this.tick >= this.scenario.totalTicks(this)) this.done = true;
  }

  // 确定性快进到指定 tick（同种子同参数 → 完全可复现，用于恢复进度）
  seek(n) {
    const target = Math.min(n, this.scenario.totalTicks(this));
    while (this.tick < target && !this.done) this.step();
    return this.tick;
  }

  latestMetrics() {
    return this.history.length ? this.history[this.history.length - 1] : {};
  }

  snapshot() {
    return {
      tick: this.tick,
      done: this.done,
      seed: this.seed,
      resourceName: this.resourceName,
      params: this.params,
      metrics: this.latestMetrics(),
      history: this.history.slice(-240),
      viz: this.scenario.visualize(this),
      events: this.events.slice(-14),
      ruleLog: this.ruleLog.slice(-20),
    };
  }
}

module.exports = { Simulation };
