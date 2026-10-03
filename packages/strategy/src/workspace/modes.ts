import type { Strategy, Statement } from '@monad-hack/contracts';
import { LanguageError } from '../errors.ts';

// Deployment-profile limits the compiler cannot see (D17, D23, D24). The editor shows them live; the
// deployment check (G3) reruns the same function. Passing it is not deployment approval.

export type Experience = 'rookie' | 'advanced';
export type ExecutionMode = 'paper' | 'live';
export interface DeploymentProfile { readonly experience: Experience; readonly mode: ExecutionMode }
export const PROFILE_LIMITS = {
  /** Paper advanced may schedule from the schema minimum; rookie and every live deployment need 60 s. */
  scheduleSeconds: { paperAdvanced: 10, otherwise: 60 },
  slippageBps: { rookie: 50, platform: 100 },
  rookie: { maxAiCallsPerRun: 1, maxIntentsPerRun: 1 },
} as const;

/** Every way `strategy` breaks the profile's limits, as `POLICY_DENIED` errors carrying a node ID and JSON Pointer. */
export function profileIssues(strategy: Strategy, profile: DeploymentProfile): LanguageError[] {
  const issues: LanguageError[] = [];
  const deny = (message: string, nodeId: string, pointer: string) => issues.push(new LanguageError('POLICY_DENIED', message, nodeId, pointer));
  const rookie = profile.experience === 'rookie';
  if (rookie && profile.mode === 'live') deny('Rookie strategies run in paper mode only.', strategy.id, '');
  const minSchedule = profile.mode === 'paper' && !rookie ? PROFILE_LIMITS.scheduleSeconds.paperAdvanced : PROFILE_LIMITS.scheduleSeconds.otherwise;
  const maxSlippage = rookie ? PROFILE_LIMITS.slippageBps.rookie : PROFILE_LIMITS.slippageBps.platform;
  if (rookie) {
    for (const key of ['maxAiCallsPerRun', 'maxIntentsPerRun'] as const) {
      if (strategy.limits[key] > PROFILE_LIMITS.rookie[key]) deny(`Rookie strategies allow at most ${PROFILE_LIMITS.rookie[key]} ${key === 'maxAiCallsPerRun' ? 'AI call' : 'trade'} per run.`, strategy.id, `/limits/${key}`);
    }
  }
  const walk = (body: readonly Statement[], pointer: string): void => body.forEach((s, i) => {
    const at = `${pointer}/${i}`;
    if (s.type === 'swap.exactInput' && s.maxSlippageBps > maxSlippage) {
      deny(`${rookie ? 'Rookie strategies allow' : 'The platform allows'} at most ${maxSlippage} bps (${maxSlippage / 100}%) slippage.`, s.id, `${at}/maxSlippageBps`);
    }
    if (s.type === 'if') { walk(s.then, `${at}/then`); walk(s.else, `${at}/else`); }
    if (s.type === 'repeat') walk(s.body, `${at}/body`);
  });
  strategy.triggers.forEach((t, i) => {
    if (t.type === 'schedule' && t.intervalSeconds < minSchedule) {
      deny(minSchedule === PROFILE_LIMITS.scheduleSeconds.otherwise
        ? `${rookie ? 'Rookie' : 'Live'} schedules need at least ${minSchedule} seconds between runs.`
        : `Schedules need at least ${minSchedule} seconds between runs.`, t.id, `/triggers/${i}/intervalSeconds`);
    }
    walk(t.body, `/triggers/${i}/body`);
  });
  return issues;
}
