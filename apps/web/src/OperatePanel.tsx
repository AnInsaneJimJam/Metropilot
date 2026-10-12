import { useCallback, useEffect, useMemo, useState } from "react";
import { describeReason } from "@monad-hack/contracts";
import type { GeneratedContractMap, Statement } from "@monad-hack/contracts";
import { api, ApiError } from "./api.ts";
import type { SavedAgent } from "./api.ts";
import type { Validation } from "./validation.ts";
import { FundsPanel } from "./FundsPanel.tsx";

type Deployment = GeneratedContractMap["agentDeployment"];
type RunSummary = GeneratedContractMap["runSummary"];
type RunDetail = GeneratedContractMap["runDetail"];
type AuditEvent = GeneratedContractMap["auditEvent2"];
type Estimate = GeneratedContractMap["paperEstimate"];
type Versions = { connectors: Record<string, string>; modelProfiles: Record<string, string> };

/** What the strategy needs: connector capabilities and model profiles, shown before launch. */
function needs(body: readonly Statement[], out = { connectors: new Map<string, Set<string>>(), models: new Set<string>() }) {
  for (const node of body) {
    if (node.type === "swap.exactInput" || node.type === "read") {
      const caps = out.connectors.get(node.connectorRef) ?? new Set<string>();
      caps.add(node.type === "read" ? node.operation : "swap.exactInput");
      out.connectors.set(node.connectorRef, caps);
    }
    if (node.type === "ai.decide") out.models.add(node.modelProfileRef);
    if (node.type === "if") {
      needs(node.then, out);
      needs(node.else, out);
    }
    if (node.type === "repeat") needs(node.body, out);
  }
  return out;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** " · Title: explanation" for a reason code from the shared vocabulary (#19); unknown codes keep their code. */
function because(code: unknown): string {
  if (typeof code !== "string" || !code) return "";
  const reason = describeReason(code);
  return ` · ${reason.title}: ${reason.explanation}${reason.known ? "" : ` (${code})`}`;
}

/** One readable line per audit event; payloads are already redacted server-side. */
function describe(e: AuditEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "deployment.stateChanged":
      return `Deployment ${String(p["from"])} → ${String(p["to"])} (generation ${String(p["generation"])})${p["reason"] ? ` · ${String(p["reason"])}` : ""}`;
    case "run.stateChanged":
      return `Run ${String(p["to"])}${because(p["reasonCode"] ?? p["errorCode"])}`;
    case "observation.skipped":
      return `No run for ${String(p["triggerId"])}${because(p["reasonCode"])}`;
    case "run.step":
      return `${String(p["kind"])} on ${String(p["nodeId"])}: ${String(p["outcome"] ?? p["stage"])}`;
    case "timeline.entry":
      return String(p["message"]);
    case "transaction.stateChanged":
      return `Paper trade ${String(p["state"])}${because(p["reason"] ?? p["conflict"])}`;
    case "ledger.settled":
      return "Virtual balances settled";
    case "reservation.changed":
      return `Virtual hold ${String(p["state"])}`;
    case "policy.denied":
      return `Trade blocked${because(p["reason"])}`;
    default:
      return e.type;
  }
}

export function OperatePanel({
  current,
  dirty,
  connected,
  validation,
}: {
  current: SavedAgent | undefined;
  dirty: boolean;
  connected: boolean;
  validation: Validation | undefined;
}) {
  const agentId = current?.id;
  const [deployment, setDeployment] = useState<Deployment | null>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetail>();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [versions, setVersions] = useState<Versions>();
  const [custody, setCustody] = useState<{ enabled: boolean; localFaucet: boolean }>({ enabled: false, localFaucet: false });
  const [estimate, setEstimate] = useState<Estimate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trimmed, setTrimmed] = useState(false);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      setDeployment(await api<Deployment>(`/agents/${agentId}/deployment`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setDeployment(null);
      else setError((e as Error).message);
    }
    try {
      setRuns((await api<{ items: RunSummary[] }>(`/agents/${agentId}/runs?limit=20`)).items);
    } catch {
      /* the deployment call already reported the problem */
    }
  }, [agentId]);

  useEffect(() => {
    setDeployment(undefined);
    setRuns([]);
    setEvents([]);
    setDetail(undefined);
    setEstimate(undefined);
    setTrimmed(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void api<{ paperVersions?: Versions; capabilities?: { custody?: boolean; localFaucet?: boolean } }>("/catalog")
      .then((c) => {
        setVersions(c.paperVersions);
        setCustody({ enabled: Boolean(c.capabilities?.custody), localFaucet: Boolean(c.capabilities?.localFaucet) });
      })
      .catch(() => undefined);
  }, []);

  // Live activity: the browser resumes with Last-Event-ID after a reconnect. A reset means retention removed events
  // after our cursor; the server already moved Last-Event-ID to the oldest kept event, so the automatic reconnect
  // continues from there. Reload state and run history, and say that older activity is gone rather than absent.
  useEffect(() => {
    if (!agentId || !connected) return;
    const source = new EventSource(`/v1/agents/${agentId}/stream`);
    source.addEventListener("audit", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AuditEvent;
      setEvents((previous) => (previous.some((e) => e.sequence === event.sequence) ? previous : [event, ...previous].slice(0, 60)));
      if (event.type === "run.stateChanged" || event.type === "deployment.stateChanged") void refresh();
    });
    source.addEventListener("reset", () => {
      setTrimmed(true);
      void refresh();
    });
    return () => source.close();
  }, [agentId, connected, refresh]);

  const plan = useMemo(() => {
    const strategy = validation?.strategy;
    if (!strategy) return undefined;
    const found = needs(strategy.triggers.flatMap((t) => t.body));
    return {
      connectors: [...found.connectors].map(([ref, caps]) => ({ ref, version: versions?.connectors[ref], capabilities: [...caps].sort() })),
      models: [...found.models].map((ref) => ({ ref, version: versions?.modelProfiles[ref] })),
    };
  }, [validation, versions]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const key = () => crypto.randomUUID();

  const launch = () =>
    run(async () => {
      if (!agentId || !current || !plan) return;
      const missing = [...plan.connectors, ...plan.models].find((item) => !item.version);
      if (missing) throw new Error(`${missing.ref} is not enabled for paper on this server.`);
      const fresh = await api<Estimate>(`/agents/${agentId}/estimates`, { method: "POST", body: "{}" });
      setEstimate(fresh);
      await api(`/agents/${agentId}/deployments`, {
        method: "POST",
        headers: { "Idempotency-Key": key() },
        body: JSON.stringify({
          schemaVersion: "deployment/1",
          agentId,
          strategyRevisionId: current.revisionId,
          mode: "paper",
          networkRef: "paper-monad",
          connectorSelections: plan.connectors.map((c) => ({ ref: c.ref, version: c.version, capabilities: c.capabilities })),
          modelProfiles: plan.models.map((m) => ({ ref: m.ref, version: m.version })),
          resourceProfileRef: "paper-small-v1",
          budgetVersion: fresh.budgetVersion,
          policyVersion: fresh.policyVersion,
          estimateId: fresh.id,
        }),
      });
    });
  const control = (kind: "pause" | "resume" | "stop") =>
    run(async () => {
      if (kind === "stop" && !window.confirm("Stop this agent? It cannot be resumed; you can launch it again later.")) return;
      // The JSON content type needs a body; the routes ignore it.
      await api(`/agents/${agentId}/${kind}`, { method: "POST", headers: { "Idempotency-Key": key() }, body: "{}" });
    });
  const open = (runId: string) =>
    run(async () => {
      setDetail(detail?.runId === runId ? undefined : await api<RunDetail>(`/runs/${runId}`));
    });

  if (!current)
    return (
      <section className="operate-page review-page" aria-label="Operate">
        <div className="section-intro">
          <span className="eyebrow">04 / OPERATE</span>
          <h2>Save it, then launch it.</h2>
          <p>Launching runs the saved revision in paper mode with virtual funds.</p>
        </div>
        <div className="empty-state">Save a revision first.</div>
      </section>
    );

  const state = deployment?.desiredState;
  const live = state === "active" || state === "paused";
  return (
    <section className="operate-page review-page" aria-label="Operate">
      <div className="section-intro">
        <span className="eyebrow">04 / OPERATE</span>
        <h2>Run it on paper.</h2>
        <p>
          The saved revision runs on the local stack with virtual funds. Prices come from finalized Monad mainnet native oracles. Trades use virtual USDC and simulated fills. AI profiles are not enabled. No wallet is connected.
        </p>
      </div>
      {error && (
        <p className="budget-error" role="alert">
          {error}
        </p>
      )}
      <div className="review-grid">
        <div className="budget-section">
          <div className="section-line">
            <h3>Deployment</h3>
            <span className="pill">
              <span className={`status-dot ${state === "active" ? "" : "amber"}`} />
              {deployment === undefined ? "Loading" : deployment === null ? "Not launched" : state}
            </span>
          </div>
          {deployment && (
            <dl className="review-limits operate-facts">
              <div>
                <dt>Generation</dt>
                <dd>{deployment.generation}</dd>
              </div>
              <div>
                <dt>Manifest</dt>
                <dd className="hash">{deployment.manifestHash.slice(0, 14)}…</dd>
              </div>
            </dl>
          )}
          {!live && plan && (
            <div className="operate-plan">
              <h4>This agent may</h4>
              <ul>
                {plan.connectors.flatMap((c) =>
                  c.capabilities.map((cap) => (
                    <li key={`${c.ref}:${cap}`}>
                      {cap === "swap.exactInput" ? "Trade" : "Read prices"} on <code>{c.ref}</code>
                      {c.version ? ` ${c.version}` : " (not enabled)"}
                    </li>
                  )),
                )}
                {plan.models.map((m) => (
                  <li key={m.ref}>
                    Ask <code>{m.ref}</code> for a typed decision{m.version ? ` ${m.version}` : " (not enabled)"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {estimate && (
            <p className="note">
              Estimated {estimate.runsPerDay} run{estimate.runsPerDay === 1 ? "" : "s"} per day, at most{" "}
              {estimate.worstCaseAiCallsPerDay} AI call{estimate.worstCaseAiCallsPerDay === 1 ? "" : "s"}. Paper quota, not a bill.
            </p>
          )}
          <div className="operate-actions">
            {!live && (
              <button className="primary" disabled={busy || dirty || !connected || !validation?.program} onClick={() => void launch()}>
                {busy ? "Working…" : "Launch on paper"}
              </button>
            )}
            {state === "active" && (
              <button disabled={busy} onClick={() => void control("pause")}>
                Pause
              </button>
            )}
            {state === "paused" && (
              <button className="primary" disabled={busy} onClick={() => void control("resume")}>
                Resume
              </button>
            )}
            {live && (
              <button disabled={busy} onClick={() => void control("stop")}>
                Stop
              </button>
            )}
          </div>
          {dirty && !live && <p className="note">Save your changes before launching; the saved revision is what runs.</p>}

          <div className="section-line operate-runs-heading">
            <h3>Runs</h3>
            <button className="link" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          {runs.length === 0 ? (
            <div className="empty-state">No runs yet. A run starts when the trigger fires.</div>
          ) : (
            <ul className="operate-runs">
              {runs.map((r) => {
                const why = r.error && describeReason(r.error.code);
                return (
                  <li key={r.runId}>
                    <button className="operate-run" aria-expanded={detail?.runId === r.runId} onClick={() => void open(r.runId)}>
                      <span className={`run-status run-${r.status}`}>{r.status}</span>
                      <span>{r.triggerId}</span>
                      <span className="muted">{time(r.createdAt)}</span>
                      {why && (
                        <span className="status-error" title={`${why.explanation} (${why.code})`}>
                          {why.title}
                        </span>
                      )}
                    </button>
                    {detail?.runId === r.runId && (
                      <ol className="operate-steps">
                        {r.error && why && (
                          <li>
                            {r.error.message} {why.userAction}
                          </li>
                        )}
                        {detail.operations.map((o) => (
                          <li key={o.operationKey}>
                            <code>{o.kind}</code> {o.nodeId} · {o.outcome ?? "dispatching"}
                          </li>
                        ))}
                        {detail.timeline.map((t) => (
                          <li key={`${t.nodeId}:${t.createdAt}`}>“{t.message}”</li>
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {custody.enabled && agentId && <FundsPanel agentId={agentId} localFaucet={custody.localFaucet} />}
        </div>
        <aside className="review-aside">
          <span className="eyebrow">LIVE ACTIVITY</span>
          {trimmed && <p className="note">Older activity was removed by retention; showing events from the oldest kept one.</p>}
          {events.length === 0 ? (
            <p className="note">Waiting for events…</p>
          ) : (
            <ol className="operate-events" aria-live="polite">
              {events.map((e) => (
                <li key={e.sequence}>
                  <span className="muted">{time(e.occurredAt)}</span>
                  <span>{describe(e)}</span>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </section>
  );
}
