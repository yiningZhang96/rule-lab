'use strict';
const sharedResource = require('./shared-resource');
const teamCollab = require('./team-collab');

const SCENARIOS = {
  [sharedResource.id]: sharedResource,
  [teamCollab.id]: teamCollab,
};

function scenarioMeta(sc) {
  return {
    id: sc.id, name: sc.name, tagline: sc.tagline, description: sc.description,
    resourceName: sc.resourceName || '', kernel: sc.kernel || sc.id, builtin: !!SCENARIOS[sc.id],
    paramSchema: sc.paramSchema, defaults: sc.defaults, interventions: sc.interventions,
    metricKeys: sc.metricKeys, agentTypes: sc.agentTypes || [],
  };
}

module.exports = { SCENARIOS, scenarioMeta };
