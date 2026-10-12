// Deployment authority read from the control API's `deployments` table (migration 0005, decision D37).
// Read on every admission and again before each fill, never cached: a pause must take effect before the
// executor capability expires. A query failure throws, which the service reports as unavailable (503).
import type pg from 'pg';
import type { AuthoritySource, DeploymentAuthority, DesiredState } from './authorization.ts';

export class PostgresAuthority implements AuthoritySource {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async current(tenantId: string, deploymentId: string): Promise<DeploymentAuthority | undefined> {
    const { rows } = await this.#pool.query<{
      tenant_id: string; agent_id: string; id: string; generation: number; mode: 'paper' | 'live'; desired_state: DesiredState;
      strategy_revision_id: string; policy_version: number; network_ref: string; connector_versions: Record<string, string>; simulation_account_id: string | null;
    }>(
      `select tenant_id, agent_id, id, generation, mode, desired_state, strategy_revision_id, policy_version, network_ref, connector_versions, simulation_account_id
       from deployments where tenant_id = $1 and id = $2`,
      [tenantId, deploymentId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id, agentId: row.agent_id, deploymentId: row.id, generation: String(row.generation), mode: row.mode, desiredState: row.desired_state,
      strategyRevisionId: row.strategy_revision_id, policyVersion: row.policy_version, networkRef: row.network_ref, connectorPins: row.connector_versions,
      ...(row.simulation_account_id ? { simulationAccountId: row.simulation_account_id } : {}),
    };
  }
}
