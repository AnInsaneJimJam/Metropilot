import fixture from './threshold-sale.json' with { type: 'json' };
import { compileStrategy, syntheticCatalog, transitionPrice, startRun, advanceRun } from './index.ts';
import type { CrossingState } from './index.ts';
const program = await compileStrategy(JSON.stringify(fixture), syntheticCatalog);
const trigger = program.strategy.triggers[0]!;
if (trigger.type !== 'price.crossesAbove') throw new Error('Expected threshold fixture');
let state: CrossingState = {};
for (const [i, price] of ['2499', '2501', '2502'].entries()) {
  const time = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const observation = { sourceEventKey: `synthetic-${i}`, feedRef: trigger.feedRef, price: { ...trigger.threshold, decimal: price }, observedAt: time, receivedAt: time };
  const decision = transitionPrice(trigger, state, observation, time); state = decision.state;
  console.log(`SYNTHETIC PAPER: price ${price} → ${decision.reason}`);
  if (!decision.fire) continue;
  const initial = await startRun(program, { deploymentRevision: 'paper-demo/1', triggerId: trigger.id, sourceEventKey: observation.sourceEventKey });
  const submitted = await advanceRun(program, initial);
  if (!submitted.command) throw new Error('Expected intent');
  console.log(`  proposed swap: ${JSON.stringify(submitted.command)}`);
  const restored = JSON.parse(JSON.stringify(submitted.checkpoint));
  const pending = await advanceRun(program, restored, { key: submitted.command.key, outcome: 'pending' });
  console.log(`  pending → ${pending.checkpoint.status}; notification blocked`);
  const settled = await advanceRun(program, restored, { key: submitted.command.key, outcome: 'settled' });
  if (!settled.command || settled.command.kind !== 'notify') throw new Error('Expected notification after synthetic settlement');
  console.log(`  synthetic settlement → ${settled.command.message}`);
  const finished = await advanceRun(program, settled.checkpoint, { key: settled.command.key, outcome: 'acknowledged' });
  console.log(`  ${finished.checkpoint.status}; ${finished.checkpoint.intents} intent; ${finished.checkpoint.steps} steps`);
}
