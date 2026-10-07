// `pnpm runtime:demo`: drives real strategies through the runtime host against in-memory stand-ins for the
// control API, API Broker and paper executor. SYNTHETIC PAPER ONLY — no network, database, model or chain.
import { PRESETS } from '@monad-hack/strategy';
import { syntheticCatalog } from '@monad-hack/strategy';
import { RuntimeError } from './errors.ts';
import { localEnvironment, PAPER_CONNECTOR_VERSIONS } from './local/environment.ts';

const preset = (id: string) => {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found.strategy;
};
const say = (line: string): void => console.log(line);
const short = (hex: string): string => `${hex.slice(0, 10)}…`;

async function thresholdSale(): Promise<void> {
  say('\n== 1. Warm agent, price trigger: threshold partial sale (push-first ingestion, D32/D33) ==');
  const env = localEnvironment({ autoSettle: false });
  const deployment = await env.control.deploy({ strategy: preset('threshold_sale'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
  const runtime = env.supervisor();
  for (const [i, price] of ['2499', '2501', '2502'].entries()) {
    env.clock.advance(400); // one finalized observation per ~block batch
    env.market.price = price;
    const observedAt = env.clock.now();
    env.clock.advance(300);
    const fanOut = await env.control.ingestPrice({ sourceEventKey: `synthetic-swap-log-${i}`, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: price }, observedAt, receivedAt: env.clock.now() });
    say(`SYNTHETIC PAPER price ${price} → ${fanOut.map((f) => f.reason).join(', ')}`);
  }
  const first = await runtime.cycle();
  const run = [...env.control.runs.values()][0]!;
  say(`  runtime: run ${short(run.runId)} → ${first.outcome} (swap intent reserved; process released, no busy wait)`);
  say(`  stage timings (ms): ${JSON.stringify(first.timings)}`);
  say(`  idle poll → ${(await runtime.cycle()).disposition}`);
  await env.executor.settlePending();
  say('  paper executor settles the synthetic fill → reconciliation records it → resume assignment queued');
  const resumed = await runtime.cycle();
  say(`  resume → ${resumed.outcome}; timeline: "${env.control.timelineRows[0]?.message}"`);
  const intent = env.executor.intents[0]!;
  say(`  intent ${short(intent.logicalKey)} ${intent.state}: sold ${intent.settlement?.inputAtomic} atomic WETH for ${intent.settlement?.outputAtomic} atomic USD (fill ${short(intent.paperFillId!)})`);
  say(`  checkpoint: ${run.checkpoint?.status}, ${run.checkpoint?.intents} intent, ${run.checkpoint?.steps} steps`);
  void deployment;
}

async function aiGated(decision: 'allow' | 'skip'): Promise<void> {
  say(`\n== 2${decision === 'allow' ? 'a' : 'b'}. Schedule agent: AI-gated purchase, AI answers ${decision} ==`);
  const env = localEnvironment({ autoSettle: true, decisions: [{ value: { decision, summary: `Synthetic AI says ${decision}.` } }] });
  await env.control.deploy({ strategy: preset('ai_gated_purchase'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
  const slots = await env.control.tickSchedules();
  say(`SYNTHETIC PAPER schedule tick → ${slots.map((s) => s.reason).join(', ')}`);
  const report = await env.supervisor().cycle();
  const kinds = env.telemetry.events.filter((e) => e.event === 'operation.result').map((e) => `${e.kind}:${e.outcome}`);
  say(`  run → ${report.outcome}; operations ${kinds.join(' → ')}`);
  say(`  timeline: "${env.control.timelineRows.at(-1)?.message}"; intents: ${env.executor.intents.length}; provider calls: ${env.broker.providerCalls}`);
}

async function crashRecovery(): Promise<void> {
  say('\n== 3. Crash recovery: the same keys, exactly one effect ==');
  for (const point of ['after-wait', 'after-dispatch'] as const) {
    const env = localEnvironment({ autoSettle: true });
    await env.control.deploy({ strategy: preset('ai_gated_purchase'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
    await env.control.tickSchedules();
    let crashed = false;
    const doomed = env.supervisor({ crashAt: (at, command) => { if (at === point && command.kind === 'swap.exactInput' && !crashed) { crashed = true; throw new Error(`simulated process death ${point}`); } } });
    await doomed.cycle().catch((error: Error) => say(`  ${error.message}`));
    const run = [...env.control.runs.values()][0]!;
    env.control.reassign(run.runId); // lease expired: a replacement process gets a newer fencing token
    const report = await env.supervisor().cycle();
    const key = env.executor.intents[0]!.logicalKey;
    say(`  crash ${point}: replacement → ${report.outcome}; executor saw ${env.executor.submissions(key)} submission(s), ${env.executor.intents.length} intent, 1 fill`);
  }
}

async function duplicates(): Promise<void> {
  say('\n== 4. Duplicate event and duplicate assignment ==');
  const env = localEnvironment({ autoSettle: true });
  await env.control.deploy({ strategy: preset('threshold_sale'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
  const observe = async (key: string, price: string) => {
    env.clock.advance(500);
    const at = env.clock.now();
    return env.control.ingestPrice({ sourceEventKey: key, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: price }, observedAt: at, receivedAt: at });
  };
  await observe('e1', '2499');
  await observe('e2', '2501');
  const again = await observe('e2', '2501');
  say(`  same source event again → ${again.map((f) => f.reason).join(', ')} (no second run)`);
  const run = [...env.control.runs.values()][0]!;
  await env.supervisor().cycle();
  env.control.reassign(run.runId);
  const report = await env.supervisor().cycle();
  say(`  duplicate assignment of a finished run → ${report.outcome}; runs: ${env.control.runs.size}; intents: ${env.executor.intents.length}`);
}

async function fencingAndPause(): Promise<void> {
  say('\n== 5. Stale fencing token and pause ==');
  const env = localEnvironment({ autoSettle: false });
  const deployment = await env.control.deploy({ strategy: preset('ai_gated_purchase'), catalog: syntheticCatalog, mode: 'paper', connectorVersions: PAPER_CONNECTOR_VERSIONS });
  await env.control.tickSchedules();
  const run = [...env.control.runs.values()][0]!;
  // A slow worker holds assignment #1 while the lease is reassigned to a newer owner.
  const stale = env.supervisor({ crashAt: (at) => { if (at === 'after-wait') env.control.reassign(run.runId); } });
  const staleReport = await stale.cycle();
  say(`  stale worker → ${staleReport.outcome} (${staleReport.code}); provider calls so far: ${env.broker.providerCalls}`);
  env.control.pause(deployment.deploymentId);
  const paused = await env.supervisor().cycle();
  say(`  after pause, replacement → ${paused.outcome} (${paused.code}); intents created: ${env.executor.intents.length}`);
  env.control.drainRuntimes();
  const drainer = env.supervisor();
  await drainer.serve();
  say(`  drain offer → runtime ${drainer.state}`);
}

try {
  say('SYNTHETIC PAPER RUNTIME DEMO — in-memory control API, broker and paper executor; nothing here is a real trade.');
  await thresholdSale();
  await aiGated('allow');
  await aiGated('skip');
  await crashRecovery();
  await duplicates();
  await fencingAndPause();
} catch (error) {
  if (error instanceof RuntimeError) console.error(`runtime error ${error.code}: ${error.message}`);
  throw error;
}
