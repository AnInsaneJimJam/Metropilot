// The local stand-ins must pass the same conformance kits the control API and executor owners will run.
import { PRESETS, syntheticCatalog } from '@monad-hack/strategy';
import { controlApiConformance } from './conformance/control-api.ts';
import { executorConformance } from './conformance/executor.ts';
import { localEnvironment, PAPER_CONNECTOR_VERSIONS } from './local/environment.ts';

const aiGated = PRESETS.find((p) => p.id === 'ai_gated_purchase')!.strategy;

controlApiConformance('LocalControlPlane', async () => {
  const env = localEnvironment();
  return {
    api: env.control,
    clock: env.clock,
    arrangeRun: async () => {
      await env.control.deploy({ strategy: aiGated, catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
      await env.control.tickSchedules();
    },
    expireLease: async (runId) => env.control.reassign(runId),
    timelineCount: async (runId) => env.control.timelineRows.filter((row) => row.runId === runId).length,
  };
});

executorConformance('PaperExecutor', async () => {
  const env = localEnvironment();
  return {
    executor: env.executor,
    arrangeRun: async () => {
      const deployment = await env.control.deploy({ strategy: aiGated, catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
      const [slot] = await env.control.tickSchedules();
      return { deploymentId: deployment.deploymentId, generation: String(deployment.generation), runId: slot!.runId! };
    },
    revoke: async (runId) => env.control.pause(env.control.runs.get(runId)!.deploymentId),
  };
});
