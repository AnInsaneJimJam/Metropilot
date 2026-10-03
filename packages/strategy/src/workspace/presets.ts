import type { Strategy } from '@monad-hack/contracts';
import thresholdSale from '../threshold-sale.json' with { type: 'json' };

// Reviewed preset documents. The editor turns each into blocks with `workspaceFromStrategy`, so a preset is
// always exactly what the shared converter and compiler accept. All assets and prices are synthetic paper data.
// Observe-and-explain and AI-gated purchase need read/ai.decide (editor plan Phase 8) and are added then.

export interface Preset { readonly id: string; readonly title: string; readonly summary: string; readonly strategy: Strategy }

export const PRESETS: readonly Preset[] = [
  {
    id: 'threshold_sale',
    title: 'Threshold partial sale',
    summary: 'When WETH crosses above 2,500 USD, sell 10% of the available WETH, then wait an hour before another crossing counts.',
    strategy: thresholdSale as Strategy, // the normative fixture from the language spec
  },
  {
    id: 'scheduled_purchase',
    title: 'Scheduled fixed purchase',
    summary: 'Once a day, buy WETH with 25 USD on Uniswap v3 and record it.',
    strategy: {
      schemaVersion: 'strategy/1',
      id: 'scheduled_purchase',
      name: 'Paper daily fixed purchase',
      triggers: [{
        id: 'daily',
        type: 'schedule',
        intervalSeconds: 86_400,
        anchorAt: '2026-01-01T00:00:00.000Z',
        body: [
          { id: 'buy_weth', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.USD', tokenOutRef: 'paper.WETH', amount: { kind: 'fixed', atomic: '25000000' }, maxSlippageBps: 30 },
          { id: 'record_purchase', type: 'notify', message: 'Daily paper purchase settled.', inputs: {} },
        ],
      }],
      limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 1, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 },
    },
  },
];
