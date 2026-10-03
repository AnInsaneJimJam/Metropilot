import type { Strategy, Expression } from '@monad-hack/contracts';
import thresholdSale from '../threshold-sale.json' with { type: 'json' };

// Reviewed preset documents. The editor turns each into blocks with `workspaceFromStrategy`, so a preset is
// always exactly what the shared converter and compiler accept. All assets, prices and models are synthetic paper data.

const field = (name: string, f: string): Expression => ({ kind: 'field', name, field: f });
const LIMITS = { maxStepsPerRun: 100, maxAiCallsPerRun: 1, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 };
const DAILY = { type: 'schedule', intervalSeconds: 86_400, anchorAt: '2026-01-01T00:00:00.000Z' } as const;
const readMarket = { id: 'read_market', type: 'read', connectorRef: 'paper.uniswap', operation: 'price.read', arguments: {}, bind: 'market' } as const;
const buyWeth = { id: 'buy_weth', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.USD', tokenOutRef: 'paper.WETH', amount: { kind: 'fixed', atomic: '25000000' }, maxSlippageBps: 30 } as const;

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
        ...DAILY,
        body: [buyWeth, { id: 'record_purchase', type: 'notify', message: 'Daily paper purchase settled.', inputs: {} }],
      }],
      limits: LIMITS,
    },
  },
  {
    id: 'observe_explain',
    title: 'Observe and explain',
    summary: 'Every 5 minutes, read the WETH price, ask AI for a short plain-language summary, and record both. No trade.',
    strategy: {
      schemaVersion: 'strategy/1',
      id: 'observe_explain',
      name: 'Paper observe and explain',
      triggers: [{
        id: 'every_5m',
        type: 'schedule',
        intervalSeconds: 300,
        anchorAt: '2026-01-01T00:00:00.000Z',
        body: [
          readMarket,
          {
            id: 'explain', type: 'ai.decide', modelProfileRef: 'paper.kimi', outputSchemaRef: 'summary/1', timeoutSeconds: 20, maxOutputTokens: 256, bind: 'explanation',
            prompt: 'In one or two sentences, describe what this WETH price observation shows. Do not recommend a trade.',
            inputs: { price: field('market', 'price'), observedAt: field('market', 'observedAt') },
          },
          { id: 'record_note', type: 'notify', message: 'Market note', inputs: { price: field('market', 'price'), summary: field('explanation', 'summary') } },
        ],
      }],
      limits: LIMITS,
    },
  },
  {
    id: 'ai_gated_purchase',
    title: 'AI-gated purchase',
    summary: 'Once a day, read the WETH price and ask AI to allow or skip; buy 25 USD of WETH only on allow. AI cannot change the amount.',
    strategy: {
      schemaVersion: 'strategy/1',
      id: 'ai_gated_purchase',
      name: 'Paper AI-gated purchase',
      triggers: [{
        id: 'daily',
        ...DAILY,
        body: [
          readMarket,
          {
            id: 'gate', type: 'ai.decide', modelProfileRef: 'paper.kimi', outputSchemaRef: 'decision/1', timeoutSeconds: 20, maxOutputTokens: 256, bind: 'gate',
            prompt: 'Answer allow only if buying a small fixed amount of WETH at this price fits a steady accumulation plan; answer skip if unsure.',
            inputs: { price: field('market', 'price'), observedAt: field('market', 'observedAt') },
          },
          {
            id: 'check_gate', type: 'if',
            condition: { kind: 'compare', operator: 'eq', left: field('gate', 'decision'), right: { kind: 'literal', valueType: 'Enum', value: 'allow' } },
            then: [buyWeth, { id: 'record_purchase', type: 'notify', message: 'AI allowed the paper purchase; it settled.', inputs: { reason: field('gate', 'summary') } }],
            else: [{ id: 'record_skip', type: 'notify', message: 'AI said skip; no purchase.', inputs: { reason: field('gate', 'summary') } }],
          },
        ],
      }],
      limits: LIMITS,
    },
  },
];
