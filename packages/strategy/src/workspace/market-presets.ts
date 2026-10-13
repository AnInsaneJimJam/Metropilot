// Actual mainnet markets; sample thresholds are editable examples, not recommendations or current quotes.
import type { Preset } from './presets.ts';
export const MARKET_PRESETS: readonly Preset[] = [
  ...([
    ['uniswap', 'WMON', 'wmon', '0.025', 'Uniswap v3 · 30s geometric TWAP'],
    ['curve', 'AUSD', 'ausd', '0.999', 'Curve · native EMA (866s parameter)'],
  ] as const).flatMap(([venue, symbol, slug, threshold, label]): Preset[] => [
    {
      id: `${venue}_threshold_purchase`, title: `${symbol} threshold purchase`,
      summary: `${label}: when ${symbol}/USDC crosses below ${threshold}, spend 10 virtual USDC. Edit the example threshold before launch.`,
      strategy: {
        schemaVersion: 'strategy/1', id: `${venue}_threshold_purchase`, name: `${symbol} paper threshold purchase`,
        triggers: [{ id: 'crossing', type: 'price.crossesBelow', feedRef: `paper.${slug}-usdc`, threshold: { baseAssetRef: `paper.${symbol}`, quoteUnit: 'USDC', decimal: threshold }, maxAgeSeconds: 30, cooldownSeconds: 3600,
          body: [{ id: 'buy', type: 'swap.exactInput', connectorRef: `paper.${venue}`, tokenInRef: 'paper.USDC', tokenOutRef: `paper.${symbol}`, amount: { kind: 'fixed', atomic: '10000000' }, maxSlippageBps: 50 }, { id: 'record', type: 'notify', message: 'Paper threshold purchase settled.', inputs: {} }] }],
        limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 },
      },
    },
    {
      id: `${venue}_threshold_sale`, title: `${symbol} threshold sale`,
      summary: `${label}: when ${symbol}/USDC crosses above ${threshold}, sell 0.1 virtual ${symbol}. Requires existing paper inventory; edit the example threshold before launch.`,
      strategy: {
        schemaVersion: 'strategy/1', id: `${venue}_threshold_sale`, name: `${symbol} paper threshold sale`,
        triggers: [{ id: 'crossing', type: 'price.crossesAbove', feedRef: `paper.${slug}-usdc`, threshold: { baseAssetRef: `paper.${symbol}`, quoteUnit: 'USDC', decimal: threshold }, maxAgeSeconds: 30, cooldownSeconds: 3600,
          body: [{ id: 'sell', type: 'swap.exactInput', connectorRef: `paper.${venue}`, tokenInRef: `paper.${symbol}`, tokenOutRef: 'paper.USDC', amount: { kind: 'fixed', atomic: symbol === 'WMON' ? '100000000000000000' : '100000' }, maxSlippageBps: 50 }, { id: 'record', type: 'notify', message: 'Paper threshold sale settled.', inputs: {} }] }],
        limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 },
      },
    },
    {
      id: `${venue}_scheduled_purchase`, title: `${symbol} scheduled purchase`, summary: `Every day, spend 10 virtual USDC on ${symbol}, priced from ${label}.`,
      strategy: { schemaVersion: 'strategy/1', id: `${venue}_scheduled_purchase`, name: `${symbol} paper scheduled purchase`,
        triggers: [{ id: 'daily', type: 'schedule', intervalSeconds: 86400, anchorAt: '2026-01-01T00:00:00.000Z', body: [
          { id: 'read_market', type: 'read', connectorRef: `paper.${venue}`, operation: 'price.read', arguments: {}, bind: 'market' },
          { id: 'buy', type: 'swap.exactInput', connectorRef: `paper.${venue}`, tokenInRef: 'paper.USDC', tokenOutRef: `paper.${symbol}`, amount: { kind: 'fixed', atomic: '10000000' }, maxSlippageBps: 50 },
        ] }], limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 } },
    },
  ]),
  ...(['USDC','AUSD'] as const).map((symbol): Preset => ({
    id: `aave_${symbol.toLowerCase()}_observe`, title: `Aave ${symbol} prices and rates`,
    summary: `Every 5 minutes, record Aave’s native ${symbol}/USD price and annualized supply/variable borrow rates. No lending action.`,
    strategy: { schemaVersion: 'strategy/1', id: `aave_${symbol.toLowerCase()}_observe`, name: `Aave ${symbol} observation`,
      triggers: [{ id:'every_5m',type:'schedule',intervalSeconds:300,anchorAt:'2026-01-01T00:00:00.000Z',body:[
        {id:'read_price',type:'read',connectorRef:'paper.aave',operation:symbol==='USDC'?'price.read':'ausd.price.read',arguments:{},bind:'market'},
        {id:'read_rates',type:'read',connectorRef:'paper.aave',operation:symbol==='USDC'?'reserve.read':'ausd.reserve.read',arguments:{},bind:'reserve'},
        {id:'record',type:'notify',message:'Aave native price and APR fractions (0.05 means 5% APR). Block read time is not the underlying oracle update time.',inputs:{price:{kind:'field',name:'market',field:'price'},supplyApr:{kind:'field',name:'reserve',field:'supplyApr'},variableBorrowApr:{kind:'field',name:'reserve',field:'variableBorrowApr'}}},
      ]}], limits:{maxStepsPerRun:100,maxAiCallsPerRun:0,maxIntentsPerRun:1,maxActiveSecondsPerRun:60} },
  })),
];
