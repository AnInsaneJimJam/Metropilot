import { expect, test } from "@playwright/test";
import type { Route } from "@playwright/test";
import { PRESETS, syntheticCatalog, workspaceFromStrategy } from "@monad-hack/strategy";

// G3 browser check of the Operate stage against a mocked control API (no database): a stopping deployment waiting
// for an open trade (#20), paper quota usage (#17), readable reasons and the retention reset note (#19).

const agentId = "019a0000-0000-7000-8000-000000000001";
const deploymentId = "019a0000-0000-7000-8000-000000000501";
const runId = `0x${"ab".repeat(32)}`;
const strategy = PRESETS.find((p) => p.id === "threshold_sale")!.strategy;
const agent = {
  schemaVersion: "control-agent/1",
  id: agentId,
  name: "Threshold sale",
  version: 1,
  revisionId: "019a0000-0000-7000-8000-000000000002",
  hash: `0x${"cd".repeat(32)}`,
  experience: "rookie",
  mode: "paper",
  state: "draft",
  workspace: workspaceFromStrategy(strategy, syntheticCatalog),
  budget: { tradingUsdMicros: "1000000000", hostingUsdMicros: "10000000", dataAndAiUsdMicros: "5000000", monReserveAtomic: "1000000000000000000" },
  updatedAt: "2026-10-13T12:00:00.000Z",
};
const audit = (sequence: number, type: string, payload: Record<string, unknown>) => ({
  schemaVersion: "audit-event/2", sequence: String(sequence), tenantId: "019a0000-0000-7000-8000-0000000000f1", agentId, deploymentId,
  actor: { kind: "controlPlane" }, traceId: "ab".repeat(16), type, occurredAt: "2026-10-13T12:00:00.000Z", payload,
});

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test("Operate: stopping waits for open trades, shows quota usage and readable reasons", async ({ page }) => {
  await page.route("**/v1/session", (route) => json(route, { tenant: "local" }));
  await page.route("**/v1/agents?limit=100", (route) => json(route, { items: [agent], nextCursor: null }));
  await page.route("**/v1/catalog", (route) => json(route, { paperVersions: { connectors: { "paper.uniswap": "1.1.0" }, modelProfiles: {} } }));
  await page.route(`**/v1/agents/${agentId}/deployment`, (route) =>
    json(route, {
      schemaVersion: "agent-deployment/1", agentId, deploymentId, generation: "1", mode: "paper", desiredState: "stopping", openIntents: 1,
      strategyRevisionId: agent.revisionId, manifestHash: `0x${"ef".repeat(32)}`, updatedAt: "2026-10-13T12:00:00.000Z",
    }));
  await page.route(`**/v1/agents/${agentId}/runs?limit=20`, (route) =>
    json(route, {
      items: [{
        schemaVersion: "run-summary/1", runId, deploymentId, generation: "1", triggerId: "crossing", status: "failed",
        error: { code: "STALE_DATA", message: "The read is older than 60 s, so the run stops.", nodeId: "sell_tenth" },
        createdAt: "2026-10-13T12:00:00.000Z", updatedAt: "2026-10-13T12:00:01.000Z",
      }],
      nextCursor: null,
    }));
  await page.route("**/v1/quota", (route) =>
    json(route, {
      schemaVersion: "paper-quota/1", concurrentAgents: { used: 0, limit: 1 }, dailySeconds: { used: 1800, limit: 7200, resetsAt: "2026-10-14T00:00:00.000Z" },
      sessionSecondsLimit: 3600, sessions: [], admissionOpen: true,
    }));
  const events = [
    audit(5, "policy.denied", { reason: "EXECUTOR_SLIPPAGE_EXCEEDED", phase: "admission" }),
    audit(6, "deployment.stateChanged", { from: "active", to: "stopping", generation: 1, openIntents: 1, reasonCode: "STOP_DRAINING" }),
  ];
  await page.route(`**/v1/agents/${agentId}/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `${events.map((e) => `id: ${e.sequence}\nevent: audit\ndata: ${JSON.stringify(e)}\n\n`).join("")}id: 6\nevent: reset\ndata: {"code":"CURSOR_EXPIRED","resumeFrom":"6"}\n\n`,
    }));

  await page.goto("/");
  await expect(page.getByText("Control API connected")).toBeVisible();
  await page.getByRole("button", { name: /^Threshold sale Draft/ }).click();
  await page.getByRole("button", { name: /Operate$/ }).first().click();

  const operate = page.getByRole("region", { name: "Operate" });
  await expect(operate.getByRole("status")).toContainText("Stopping — waiting for 1 open paper trade to settle or be cancelled");
  await expect(operate.getByRole("button", { name: "Launch on paper" })).toHaveCount(0);
  await expect(operate.getByLabel("Paper quota")).toContainText("Paper time today: 30 of 120 min");
  await expect(operate.getByLabel("Paper quota")).toContainText("0 of 1 paper agent running");
  await expect(operate.locator(".status-error")).toHaveText("Data too old");
  const activity = operate.locator(".operate-events");
  await expect(activity).toContainText("Trade blocked · Slippage too high: The requested slippage is above the approved limit.");
  await expect(activity).toContainText("Deployment active → stopping (generation 1) · Stopping: The agent is stopping");
  await expect(operate.getByText("Older activity was removed by retention")).toBeVisible();
});

test("Operate: quota time and the open-trade count refresh on their own while stopping", async ({ page }) => {
  await page.clock.install();
  const state = { openIntents: 2, usedSeconds: 1800 };
  await page.route("**/v1/session", (route) => json(route, { tenant: "local" }));
  await page.route("**/v1/agents?limit=100", (route) => json(route, { items: [agent], nextCursor: null }));
  await page.route("**/v1/catalog", (route) => json(route, { paperVersions: { connectors: { "paper.uniswap": "1.1.0" }, modelProfiles: {} } }));
  await page.route(`**/v1/agents/${agentId}/deployment`, (route) =>
    json(route, {
      schemaVersion: "agent-deployment/1", agentId, deploymentId, generation: "1", mode: "paper", desiredState: "stopping", openIntents: state.openIntents,
      strategyRevisionId: agent.revisionId, manifestHash: `0x${"ef".repeat(32)}`, updatedAt: "2026-10-13T12:00:00.000Z",
    }));
  await page.route(`**/v1/agents/${agentId}/runs?limit=20`, (route) => json(route, { items: [], nextCursor: null }));
  await page.route("**/v1/quota", (route) =>
    json(route, {
      schemaVersion: "paper-quota/1", concurrentAgents: { used: 0, limit: 1 }, dailySeconds: { used: state.usedSeconds, limit: 7200, resetsAt: "2026-10-14T00:00:00.000Z" },
      sessionSecondsLimit: 3600, sessions: [], admissionOpen: true,
    }));
  // A quiet stream: no event arrives, so only the bounded poll can notice the changes.
  await page.route(`**/v1/agents/${agentId}/stream`, (route) => route.fulfill({ status: 204 }));

  await page.goto("/");
  await expect(page.getByText("Control API connected")).toBeVisible();
  await page.getByRole("button", { name: /^Threshold sale Draft/ }).click();
  await page.getByRole("button", { name: /Operate$/ }).first().click();
  const operate = page.getByRole("region", { name: "Operate" });
  await expect(operate.getByRole("status")).toContainText("waiting for 2 open paper trades");
  await expect(operate.getByLabel("Paper quota")).toContainText("Paper time today: 30 of 120 min");

  state.openIntents = 1;
  state.usedSeconds = 2400;
  await page.clock.fastForward(6_000);
  await expect(operate.getByRole("status")).toContainText("waiting for 1 open paper trade to settle");
  await expect(operate.getByLabel("Paper quota")).toContainText("Paper time today: 40 of 120 min");
});
