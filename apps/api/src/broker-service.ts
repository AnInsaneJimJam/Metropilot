import { AiAllowance } from './ai-allowance.ts';
import type { KimiBroker } from './kimi-broker.ts';
import type pg from "pg";
import { checkedObservation, rayToApr, SOURCES } from '@monad-hack/connectors';
import { canonicalize, contentHash, parse } from "@monad-hack/contracts";
import type {
  BrokerRequest,
  BrokerResult,
  RunCheckpoint,
} from "@monad-hack/contracts";
import { verifyCapability } from "@monad-hack/contracts/capability";
import { advanceRun, compileStrategy } from "@monad-hack/strategy";
import type { Catalog } from "@monad-hack/strategy";
import { BrokerStore } from "./broker-store.ts";
import type { BrokerScope } from "./broker-store.ts";
import { ControlError, newId } from "./control.ts";

export interface PaperBrokerOptions {
  pool: pg.Pool;
  secret: Uint8Array;
  /** Explicitly synthetic; tests may inject delayed/ambiguous answers. No provider credentials. */
  decide?: (request: BrokerRequest) => Promise<BrokerResult>;
  now?: () => Date;
  kimi?: KimiBroker;
}

export class PaperBrokerService {
  readonly store: BrokerStore;
  readonly allowance: AiAllowance;
  readonly options: PaperBrokerOptions;
  constructor(options: PaperBrokerOptions) {
    this.options = options;
    this.store = new BrokerStore(options.pool);
    this.allowance = new AiAllowance(options.pool, options.now);
  }

  async request(token: string, request: BrokerRequest): Promise<BrokerResult> {
    const now = this.options.now?.() ?? new Date();
    let claims;
    try {
      claims = verifyCapability(
        token,
        this.options.secret,
        Math.floor(now.getTime() / 1000),
        "broker",
      );
    } catch {
      throw new ControlError(
        401,
        "UNAUTHENTICATED",
        "A valid broker capability is required.",
      );
    }
    if (
      claims.mode !== "paper" ||
      claims.runId !== request.runId ||
      !claims.actions.includes(request.kind)
    )
      throw new ControlError(
        403,
        "FORBIDDEN",
        "This capability does not cover the broker request.",
      );
    const scope: BrokerScope = {
      tenantId: claims.tenantId,
      deploymentId: claims.deploymentId,
      generation: claims.generation,
      runId: request.runId,
    };
    const context = await this.options.pool.query<{
      checkpoint: RunCheckpoint;
      strategy: string;
      catalog: string;
      model_profiles: Record<string, string>;
      connector_versions: Record<string, string>;
    }>(
      `select r.checkpoint,s.body as strategy,c.body as catalog,d.model_profiles,d.connector_versions
       from runs r join tenants t on t.id=r.tenant_id and t.state='active' join deployments d on d.tenant_id=r.tenant_id and d.id=r.deployment_id
       join artifacts s on s.deployment_id=d.id and s.kind='strategy' join artifacts c on c.deployment_id=d.id and c.kind='catalog'
       join run_assignments a on a.tenant_id=r.tenant_id and a.run_id=r.run_id
       where r.tenant_id=$1 and r.run_id=$2 and d.id=$3 and r.generation=$4 and d.generation=r.generation
       and d.desired_state='active' and r.status<>'revoked' and a.assignment_id=$5
       and a.lease_expires_at>$6 and a.capability_expires_at>$6
       and a.fencing_token=(select max(fencing_token) from run_assignments where run_id=r.run_id)`,
      [
        scope.tenantId,
        scope.runId,
        scope.deploymentId,
        scope.generation,
        claims.jti,
        now.toISOString(),
      ],
    );
    const row = context.rows[0];
    if (!row)
      throw new ControlError(
        403,
        "FORBIDDEN",
        "The broker assignment is expired, fenced or revoked.",
      );
    const catalog = JSON.parse(row.catalog) as Catalog;
    const program = await compileStrategy(row.strategy, catalog);
    const provenance = {
      sourceRef:
        request.kind === "read"
          ? request.connectorRef!
          : request.modelProfileRef!,
      contentHash: await contentHash(request),
    };
    const answer = await this.store.execute(scope, request, provenance, async () => {
      const refuse = (
        code: NonNullable<BrokerResult["reason"]>["code"],
        message: string,
      ): BrokerResult => ({
        schemaVersion: "broker-result/1",
        operationKey: request.operationKey,
        disposition: "refused",
        reason: { code, message },
      });
      const command = (await advanceRun(program, row.checkpoint)).command;
      if (!command || (command.kind !== "read" && command.kind !== "ai.decide"))
        return refuse("BROKER_NOT_ALLOWED", "No broker command is waiting.");
      const { key: _key, ...fields } = command;
      if (
        canonicalize({
          schemaVersion: "broker-request/1",
          operationKey: request.operationKey,
          ...fields,
        }) !== canonicalize(request)
      )
        return refuse(
          "BROKER_NOT_ALLOWED",
          "The request differs from the approved waiting command.",
        );
      let result: BrokerResult;
      if (request.kind === "read") {
        const connector = request.connectorRef!;
        const definition = catalog.reads[connector]?.[request.operation!];
        const nativeSource = SOURCES.find(source => source.connectorRef === connector &&
          catalog.connectors[connector]?.version === source.connectorVersion &&
          (source.protocol !== 'aave-v3' || source.base === (request.operation?.startsWith('ausd.') ? 'AUSD' : 'USDC')));
        if (nativeSource) {
          if (!definition || !row.connector_versions[connector] || row.connector_versions[connector] !== claims.connectors[connector] || Object.keys(request.arguments ?? {}).length)
            return refuse('BROKER_NOT_ALLOWED', 'The native read capability is not pinned for this deployment.');
          const saved = (await this.options.pool.query<{ document: unknown }>('select document from finalized_market_observations where feed_ref=$1 order by (document->>\'observedAt\') desc limit 1', [nativeSource.feedRef])).rows[0];
          let observation;
          try { observation = saved ? checkedObservation(saved.document, now.getTime()) : undefined; }
          catch { return refuse('BROKER_STALE_DATA', 'A verified finalized market observation is required.'); }
          if (!observation || now.getTime() - Date.parse(observation.observedAt) > definition.maxAgeSeconds * 1000)
            return refuse('BROKER_STALE_DATA', 'A fresh finalized market observation is required.');
          const value = request.operation?.endsWith('reserve.read') && observation.reserve
            ? { supplyApr: rayToApr(observation.reserve.supplyRateRay), variableBorrowApr: rayToApr(observation.reserve.variableBorrowRateRay), observedAt: observation.observedAt }
            : { price: observation.price, observedAt: observation.observedAt };
          provenance.sourceRef = nativeSource.feedRef;
          provenance.contentHash = await contentHash(observation);
          result = { schemaVersion: 'broker-result/1', operationKey: request.operationKey, disposition: 'completed', resultId: newId(), value, observedAt: observation.observedAt, receivedAt: now.toISOString() };
        } else {
        if (
          !definition ||
          request.operation !== "price.read" ||
          !row.connector_versions[connector] ||
          row.connector_versions[connector] !== claims.connectors[connector]
        )
          return refuse(
            "BROKER_NOT_ALLOWED",
            "The read capability is not pinned for this deployment.",
          );
        const feeds = Object.entries(catalog.feeds).filter(
          ([, feed]) => feed.connectorRef === connector,
        );
        if (feeds.length !== 1)
          return refuse(
            "BROKER_NOT_ALLOWED",
            "The read has no unique approved feed.",
          );
        const [feedRef, feed] = feeds[0]!;
        const observation = await this.options.pool.query<{
          price: string;
          observed_at: Date;
          received_at: Date;
          source_event_key: string;
          base_asset_ref: string;
          quote_unit: string;
        }>(
          "select * from market_observations where feed_ref=$1 and observed_at<=$2 order by observed_at desc,source_event_key desc limit 1",
          [feedRef, now.toISOString()],
        );
        const market = observation.rows[0];
        if (
          !market ||
          market.base_asset_ref !== feed.baseAssetRef ||
          market.quote_unit !== feed.quoteUnit ||
          market.received_at > now ||
          now.getTime() - market.observed_at.getTime() >
            definition.maxAgeSeconds * 1000
        )
          return refuse(
            "BROKER_STALE_DATA",
            "A fresh recorded market observation is required.",
          );
        const value = {
          price: {
            decimal: market.price
              .replace(/(\.\d*?)0+$/, "$1")
              .replace(/\.$/, ""),
            baseAssetRef: market.base_asset_ref,
            quoteUnit: market.quote_unit,
          },
          observedAt: market.observed_at.toISOString(),
        };
        // Persist the actual source identity, not a fabricated market or provider URL.
        provenance.sourceRef = feedRef;
        provenance.contentHash = await contentHash({
          sourceEventKey: market.source_event_key,
          value,
        });
        result = {
          schemaVersion: "broker-result/1",
          operationKey: request.operationKey,
          disposition: "completed",
          resultId: newId(),
          value,
          observedAt: value.observedAt,
          receivedAt: now.toISOString(),
        };
        }
      } else {
        const profile = catalog.modelProfiles[request.modelProfileRef!];
        if (!row.model_profiles[request.modelProfileRef!] || !profile || profile.mode !== 'paper')
          return refuse('BROKER_NOT_ALLOWED', 'The model profile is not enabled for this paper deployment.');
        let ceiling = 0n;
        const kimi = profile.provider === 'kimi' ? this.options.kimi : undefined;
        if (profile.provider === 'kimi') {
          if (!kimi || !kimi.adapter.enabled || profile.modelId !== kimi.modelId || row.model_profiles[request.modelProfileRef!] !== kimi.profileVersion)
            return refuse('BROKER_NOT_ALLOWED', 'The exact Kimi profile is not verified or pinned.');
          try { ceiling = kimi.adapter.prepare(request).reservedUsdMicros; }
          catch { return refuse('BROKER_BUDGET_EXHAUSTED', 'This AI request exceeds the bounded profile.'); }
        } else if (profile.provider !== 'synthetic') return refuse('BROKER_NOT_ALLOWED', 'The model provider is not enabled.');
        await this.allowance.settleKnown();
        if (kimi) {
          result = await kimi.dispatch(scope, request, this.allowance);
        } else {
          const allowance = await this.allowance.reserve(scope, request.operationKey, ceiling);
          if (!allowance.allowed) return refuse('BROKER_BUDGET_EXHAUSTED', allowance.message);
          result = this.options.decide
            ? await this.options.decide(request)
            : {
                schemaVersion: "broker-result/1",
                operationKey: request.operationKey,
                disposition: "completed",
                resultId: newId(),
                receivedAt: now.toISOString(),
                value:
                  request.outputSchemaRef === "decision/1"
                    ? {
                        decision: "allow",
                        summary:
                          "Synthetic decision; no model provider was called.",
                      }
                    : {
                        summary:
                          "Synthetic summary; no model provider was called.",
                      },
              };
        }
      }
      if (!parse("brokerResult", JSON.stringify(result)).ok)
        return refuse(
          "BROKER_OUTPUT_INVALID",
          "The broker answer does not match its wire contract.",
        );
      if (result.disposition === "completed") {
        const checked = await advanceRun(program, row.checkpoint, {
          key: command.key,
          outcome: "recorded",
          result: result.value,
          ...(result.receivedAt ? { receivedAt: result.receivedAt } : {}),
        });
        if (checked.checkpoint.status === "failed" && checked.checkpoint.error?.nodeId === request.nodeId)
          return refuse(
            "BROKER_OUTPUT_INVALID",
            "The broker answer does not match the declared result type.",
          );
      }
      return result;
    });
    if (request.kind === 'ai.decide') await this.allowance.settleKnown();
    return answer;
  }

  async reconcile(
    scope: BrokerScope,
    request: BrokerRequest,
    answer: BrokerResult,
  ): Promise<BrokerResult> {
    const context = await this.options.pool.query<{
      checkpoint: RunCheckpoint;
      strategy: string;
      catalog: string;
    }>(
      `select r.checkpoint,s.body as strategy,c.body as catalog from runs r
       join artifacts s on s.tenant_id=r.tenant_id and s.deployment_id=r.deployment_id and s.kind='strategy'
       join artifacts c on c.tenant_id=r.tenant_id and c.deployment_id=r.deployment_id and c.kind='catalog'
       where r.tenant_id=$1 and r.run_id=$2 and r.deployment_id=$3 and r.generation=$4`,
      [scope.tenantId, scope.runId, scope.deploymentId, scope.generation],
    );
    const row = context.rows[0];
    if (!row) throw new ControlError(404, "NOT_FOUND", "Broker run not found.");
    if (answer.disposition === "completed") {
      const program = await compileStrategy(
        row.strategy,
        JSON.parse(row.catalog) as Catalog,
      );
      const step = await advanceRun(program, row.checkpoint);
      const checked =
        step.command &&
        (await advanceRun(program, row.checkpoint, {
          key: step.command.key,
          outcome: "recorded",
          result: answer.value,
          ...(answer.receivedAt ? { receivedAt: answer.receivedAt } : {}),
        }));
      if (
        !parse("brokerResult", JSON.stringify(answer)).ok ||
        !checked ||
        (checked.checkpoint.status === "failed" && checked.checkpoint.error?.nodeId === request.nodeId)
      )
        answer = {
          schemaVersion: "broker-result/1",
          operationKey: request.operationKey,
          disposition: "refused",
          reason: {
            code: "BROKER_OUTPUT_INVALID",
            message:
              "Reconciled output does not match the declared result type.",
          },
        };
    }
    return this.store.resolve(scope, request, answer, {
      sourceRef:
        request.kind === "read"
          ? request.connectorRef!
          : request.modelProfileRef!,
      contentHash: await contentHash(answer),
    });
  }
}
