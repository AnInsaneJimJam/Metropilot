import type { Strategy, Statement, Trigger } from '@monad-hack/contracts';
import type { Experience } from '@monad-hack/strategy';
import type { Validation } from '../validation.ts';

// The in-app steps of docs/guide/strategy-tutorial.md. Each step is ticked from the live validation result,
// so the tutorial checks what is on the canvas rather than which buttons were pressed.

interface Context { readonly experience: Experience; readonly validation: Validation | undefined }
type Swap = Extract<Statement, { type: 'swap.exactInput' }>;
type Crossing = Extract<Trigger, { type: 'price.crossesAbove' }>;
const crossingOf = (s: Strategy | undefined): Crossing | undefined => s?.triggers.find((t): t is Crossing => t.type === 'price.crossesAbove');
const swapOf = (t: Crossing | undefined): Swap | undefined => t?.body.find((s): s is Swap => s.type === 'swap.exactInput');

const STEPS: readonly { readonly text: string; readonly done: (c: Context) => boolean }[] = [
  {
    text: 'Choose rookie and load the threshold partial-sale preset.',
    done: c => c.experience === 'rookie' && crossingOf(c.validation?.strategy) !== undefined,
  },
  {
    text: 'Use the synthetic WETH/USD feed (Uniswap v3 TWAP) and sell on Uniswap v3.',
    done: c => { const t = crossingOf(c.validation?.strategy); return t?.feedRef === 'paper.weth-usd' && swapOf(t)?.connectorRef === 'paper.uniswap'; },
  },
  {
    text: 'Set the crossing threshold to 2500 and the sale to 10 % of available WETH.',
    done: c => {
      const t = crossingOf(c.validation?.strategy); const swap = swapOf(t);
      return t?.threshold.decimal === '2500' && swap?.tokenInRef === 'paper.WETH' && swap.amount.kind === 'positionBps' && swap.amount.bps === 1000;
    },
  },
  {
    text: 'Keep the one-hour cooldown (3600 seconds before another crossing counts).',
    done: c => crossingOf(c.validation?.strategy)?.cooldownSeconds === 3600,
  },
  {
    text: 'Fix every problem until the panel shows a hash. Permission review and launching with virtual funds come with deployment.',
    done: c => c.validation?.program !== undefined && c.validation.problems.length === 0,
  },
];

export function Tutorial({ experience, validation, onStart }: Context & { readonly onStart: () => void }) {
  const done = STEPS.map(step => step.done({ experience, validation }));
  return (
    <details className="tutorial">
      <summary>Tutorial: a threshold sale in paper mode ({done.filter(Boolean).length}/{STEPS.length})</summary>
      <p className="muted">All prices and assets are synthetic. This teaches how blocks behave; it is not trading advice.</p>
      <button type="button" onClick={onStart}>Start: rookie + threshold preset</button>
      <ol>
        {STEPS.map((step, i) => (
          <li key={step.text} className={done[i] ? 'step-done' : undefined}>
            <span className="visually-hidden">{done[i] ? 'Done: ' : 'To do: '}</span>{step.text}
          </li>
        ))}
      </ol>
      <h4>What should happen</h4>
      <table>
        <thead><tr><th scope="col">Prices in order</th><th scope="col">Behaviour</th></tr></thead>
        <tbody>
          <tr><td>2499</td><td>Sets a baseline; no sale</td></tr>
          <tr><td>2501</td><td>One upward crossing; proposes a 10 % sale</td></tr>
          <tr><td>2502</td><td>Still above; no second sale</td></tr>
          <tr><td>Stale gap, then above</td><td>New baseline; no crossing assumed during the gap</td></tr>
        </tbody>
      </table>
      <p className="muted">“10 %” is of the WETH available when the executor authorizes the trade. Smaller amount caps, stale prices or poor liquidity can still block it.</p>
    </details>
  );
}
