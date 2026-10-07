// Wires the runtime to in-memory stand-ins for one local paper environment. Everything is synthetic and
// labelled; this is the harness behind `pnpm runtime:demo`, the host tests and the conformance self-check.
import { syntheticCatalog } from '@monad-hack/strategy';
import type { RuntimeConfig } from '../config.ts';
import { Supervisor } from '../supervisor.ts';
import type { SupervisorDeps } from '../supervisor.ts';
import { Telemetry } from '../telemetry.ts';
import { LocalControlPlane } from './control-plane.ts';
import { PaperExecutor } from './paper-executor.ts';
import { ScriptedBroker } from './scripted-broker.ts';
import type { ScriptAnswer } from './scripted-broker.ts';
import { ManualClock } from './support.ts';

export const LOCAL_IMAGE_DIGEST = '0x' + '5a'.repeat(32);
export const PAPER_CONNECTOR_VERSIONS = { 'paper.uniswap': '1.0.0', 'paper.kuru': '1.0.0' } as const;

export interface LocalOptions {
  /** Executor settles at admission (true) or later through settlePending() → reconciliation → resume (false). */
  autoSettle?: boolean;
  /** Synthetic AI answers, consumed in order; default allow. */
  decisions?: ScriptAnswer[];
  /** Override the price.read answer (e.g. a stale observation or a refusal). */
  read?: () => ScriptAnswer;
}

/** Exact decimal string → [integer digits, fractional scale]. */
function scaled(decimal: string): [bigint, bigint] {
  const [whole, fraction = ''] = decimal.split('.');
  return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
}

export function localEnvironment(options: LocalOptions = {}) {
  const clock = new ManualClock();
  const market = { price: '2500' };
  const control = new LocalControlPlane({ clock, imageDigest: LOCAL_IMAGE_DIGEST });
  const decisions = [...(options.decisions ?? [])];
  const broker = new ScriptedBroker({
    clock,
    read: options.read ?? (() => ({ value: { price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: market.price }, observedAt: clock.now() }, observedAt: clock.now() })),
    decide: () => decisions.shift() ?? { value: { decision: 'allow', summary: 'Synthetic AI: steady accumulation fits.' } },
  });
  const balances = new Map<string, bigint>([['paper.WETH', 2n * 10n ** 18n], ['paper.USD', 10_000n * 10n ** 6n], ['paper.MON', 10n ** 18n]]);
  const decimals = (ref: string): bigint => BigInt(syntheticCatalog.assets[ref]?.decimals ?? 18);
  const executor = new PaperExecutor({
    clock,
    authorityFor: (runId) => control.authorityFor(runId),
    balances,
    autoSettle: options.autoSettle ?? false,
    // Paper fill at the recorded synthetic WETH/USD price with exact floor arithmetic, 30 bps declared fee.
    fill: (intent, input) => {
      const [price, scale] = scaled(market.price);
      const gross = intent.tokenInRef === 'paper.WETH'
        ? (input * price * 10n ** decimals('paper.USD')) / (scale * 10n ** decimals('paper.WETH'))
        : (input * scale * 10n ** decimals('paper.WETH')) / (price * 10n ** decimals('paper.USD'));
      return (gross * 9_970n) / 10_000n;
    },
    onSettled: async (intent, result) => control.settleOperation(intent.runId, intent.logicalKey, result.state === 'settled' ? 'settled' : 'failed', result.intentId),
  });
  const config: RuntimeConfig = { runtimeId: 'runtime-local-1', mode: 'paper', imageDigest: LOCAL_IMAGE_DIGEST, heartbeatMillis: 10_000, pollWaitSeconds: 0 };
  const telemetry = new Telemetry();
  const supervisor = (extra: Partial<SupervisorDeps> = {}): Supervisor => new Supervisor({ config, control, broker, executor, clock, telemetry, ...extra });
  return { clock, market, control, broker, executor, balances, config, telemetry, supervisor };
}
