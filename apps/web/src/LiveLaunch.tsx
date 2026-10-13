import { useState } from "react";
import type { GeneratedContractMap } from "@monad-hack/contracts";
import { api } from "./api.ts";

type LiveEstimate = GeneratedContractMap["liveEstimate"];
type Limits = { maxSlippageBps: number; dailyActionCount: number; dailyNotionalUsdMicros: string };

const LIVE_CONNECTOR = "mainnet.uniswap-v3";

/**
 * Go live with the saved strategy (D61): set caps with a one-time code, then launch on the live network with real
 * funds from the agent's trading allocation. The server promotes the paper strategy to live tokens and refuses what
 * live v1 cannot run (market reads, AI steps, price triggers).
 */
export function LiveLaunch({ agentId, revisionId, networkRef, connectorVersion, disabled, onLaunched }: {
  agentId: string;
  revisionId: string;
  networkRef: string;
  connectorVersion: string | undefined;
  disabled: boolean;
  onLaunched: () => void;
}) {
  const [slippage, setSlippage] = useState("50");
  const [trades, setTrades] = useState("5");
  const [usd, setUsd] = useState("5");
  const [challenge, setChallenge] = useState<{ id: string; limits: Limits }>();
  const [code, setCode] = useState("");
  const [approved, setApproved] = useState<{ policyVersion: number; approvalId: string; limits: Limits }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const limits = (): Limits => {
    const micros = Math.round(Number(usd) * 1_000_000);
    if (!Number.isFinite(micros) || micros < 1) throw new Error("Enter a daily USD limit above zero.");
    return { maxSlippageBps: Number(slippage), dailyActionCount: Number(trades), dailyNotionalUsdMicros: String(micros) };
  };
  const requestCode = () =>
    run(async () => {
      const terms = limits();
      const started = await api<{ challengeId: string }>("/step-up/challenges", { method: "POST", body: JSON.stringify({ purpose: "livePolicy", agentId, limits: terms }) });
      setChallenge({ id: started.challengeId, limits: terms });
      setApproved(undefined);
    });
  const confirmCode = () =>
    run(async () => {
      if (!challenge) return;
      await api(`/step-up/challenges/${challenge.id}/verify`, { method: "POST", body: JSON.stringify({ code }) });
      const set = await api<{ policyVersion: number }>(`/agents/${agentId}/live-policy`, { method: "POST", body: JSON.stringify({ limits: challenge.limits, stepUpId: challenge.id }) });
      setApproved({ policyVersion: set.policyVersion, approvalId: challenge.id, limits: challenge.limits });
      setChallenge(undefined);
      setCode("");
    });
  const goLive = () =>
    run(async () => {
      if (!approved || !connectorVersion) return;
      if (!window.confirm(`Go live on ${networkRef}? The agent trades real funds from its trading allocation, within ${approved.limits.dailyActionCount} trades and $${Number(approved.limits.dailyNotionalUsdMicros) / 1e6} per day.`)) return;
      const estimate = await api<LiveEstimate>(`/agents/${agentId}/estimates`, { method: "POST", body: JSON.stringify({ mode: "live" }) });
      await api(`/agents/${agentId}/deployments`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          schemaVersion: "deployment/1", agentId, strategyRevisionId: revisionId, mode: "live", networkRef, stepUpApprovalId: approved.approvalId,
          connectorSelections: [{ ref: LIVE_CONNECTOR, version: connectorVersion, capabilities: ["swap.exactInput"] }], modelProfiles: [],
          resourceProfileRef: "live-small-v1", budgetVersion: estimate.budgetVersion, policyVersion: estimate.policyVersion, estimateId: estimate.id,
        }),
      });
      onLaunched();
    });

  return (
    <div className="operate-plan live-launch" aria-label="Go live">
      <h4>Go live (real funds)</h4>
      <p className="note">
        Runs this saved strategy on {networkRef} through Uniswap v3 with real MON, WMON or USDC from the agent&apos;s trading allocation. Live agents run
        schedule triggers and swaps only for now. Caps need a one-time code and apply on top of the platform limits.
      </p>
      <div className="live-caps">
        <label>
          Max slippage (bps)
          <input type="number" min={1} max={100} value={slippage} onChange={(e) => setSlippage(e.target.value)} />
        </label>
        <label>
          Trades per day
          <input type="number" min={1} max={100} value={trades} onChange={(e) => setTrades(e.target.value)} />
        </label>
        <label>
          USD per day
          <input type="number" min={0.01} step={0.01} value={usd} onChange={(e) => setUsd(e.target.value)} />
        </label>
      </div>
      {!challenge && (
        <button disabled={busy || disabled} onClick={() => void requestCode()}>
          {approved ? "Change caps" : "Approve caps"}
        </button>
      )}
      {challenge && (
        <div className="live-code">
          <label>
            One-time code
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button className="primary" disabled={busy || code.length !== 6} onClick={() => void confirmCode()}>
            Confirm caps
          </button>
        </div>
      )}
      {approved && (
        <>
          <p className="note" role="status">
            Caps approved (policy {approved.policyVersion}): {approved.limits.maxSlippageBps} bps, {approved.limits.dailyActionCount} trades and $
            {Number(approved.limits.dailyNotionalUsdMicros) / 1e6} per day. The approval is valid for one hour.
          </p>
          <button className="primary danger" disabled={busy || disabled || !connectorVersion} onClick={() => void goLive()}>
            {busy ? "Working…" : "Go live"}
          </button>
        </>
      )}
      {!connectorVersion && <p className="note">The live Uniswap connector is not enabled on this server.</p>}
      {error && (
        <p className="budget-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
