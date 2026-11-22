'use strict';
// 规则构思器：不依赖付费 AI API，基于「领域识别 + 规则模板」为用户新定义的场景生成一套规则
// 返回一个以内置 kernel（共享资源/团队协作）为引擎、但名称/标签/单位/默认值可自定义的场景提案
const { SCENARIOS } = require('./scenarios');

const TEAM_WORDS = ['团队', '协作', '小组', '作业', '项目', '社团', '排班', '志愿者', '分工', '评分', '贡献', '组队', '委员会', '研究', '评审', '绩效', '拼团', '部门', '班组'];
const RES_WORDS = ['共享', '公共', '预约', '设备', '充电', '洗衣机', '自习', '占座', '停车', '车位', '带宽', '限速', '名额', '资源', '借用', '排队', '教室', '会议室', '打印机', '淋浴', '球场', '席位', '额度', '柜', '使用', '租赁', '床位'];

const NOUN_PATTERNS = ['充电桩', '会议室', '自习座位', '停车位', '带宽流量', '带宽', '名额', '打印机', '淋浴间', '球场', '洗衣机', '座位', '车位', '床位', '资源'];

function classify(text) {
  const t = String(text || '').toLowerCase();
  let team = 0, res = 0;
  for (const w of TEAM_WORDS) if (t.includes(w.toLowerCase())) team++;
  for (const w of RES_WORDS) if (t.includes(w.toLowerCase())) res++;
  return team > res ? 'team-collab' : 'shared-resource';
}

function extractNoun(text) {
  for (const n of NOUN_PATTERNS) if ((text || '').includes(n)) return n;
  return null;
}

// 把内置「洗衣机」术语替换为用户场景的资源名词
function localizeShared(schema, noun) {
  const r = noun || '资源';
  const c = Object.assign({}, schema);
  const rep = s => String(s).replace(/洗衣机/g, r).replace(/机器/g, r).replace(/设备/g, r).replace(/洗涤/g, '使用').replace(/住户/g, '用户');
  c.label = rep(c.label);
  if (c.hint) c.hint = rep(c.hint);
  return c;
}

function generate(name, description) {
  const text = description || name || '';
  const kernel = classify(text);
  const base = SCENARIOS[kernel];
  const noun = extractNoun(text);
  const isResource = kernel === 'shared-resource';
  const paramSchema = base.paramSchema.map(s => isResource ? localizeShared(s, noun) : Object.assign({}, s));
  const resourceName = noun || (isResource ? '资源' : '');
  return {
    kernel,
    name: (name || '').trim() || '未命名场景',
    tagline: isResource ? `自定义共享资源 · ${resourceName}` : '自定义协作场景',
    description: description || '用户自定义的场景',
    resourceName,
    paramSchema,
    metricKeys: base.metricKeys.map(k => Object.assign({}, k)),
    agentTypes: (base.agentTypes || []).map(a => Object.assign({}, a)),
    interventions: base.interventions.map(i => Object.assign({}, i)),
    recommendedKeys: isResource
      ? ['machineCount', 'washTicks', 'reservationEnabled', 'maxReservations', 'noShowPenalty', 'usageFee', 'queueMode']
      : ['teams', 'tasksPerRound', 'assignment', 'scoring', 'rewardModel', 'peerReviewCount', 'auditChance'],
  };
}

module.exports = { generate };