// Service and HTTP clients run the same replay and authority contract.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validate } from "@monad-hack/contracts";
import type { BrokerRequest } from "@monad-hack/contracts";
import type { Broker } from "../ports.ts";
import { RuntimeError } from "../errors.ts";

export interface BrokerHarness {
  broker: Broker;
  arrange(kind: "read" | "ai.decide"): Promise<BrokerRequest>;
  revoke(runId: string): Promise<void>;
}
export function brokerConformance(
  name: string,
  make: () => Promise<BrokerHarness>,
): void {
  describe(`broker conformance: ${name}`, () => {
    test("read returns a recorded market, not a hard-coded price; replay preserves result identity", async () => {
      const h = await make();
      const request = await h.arrange("read");
      const first = await h.broker.request(request);
      assert.ok(validate("brokerResult", first).ok);
      assert.equal(first.disposition, "completed");
      assert.equal(
        (first.value?.["price"] as { decimal: string }).decimal,
        "2678.5",
      );
      assert.deepEqual(await h.broker.request(structuredClone(request)), first);
    });
    test("AI returns a bounded typed record and replays without dispatch", async () => {
      const h = await make();
      const request = await h.arrange("ai.decide");
      const first = await h.broker.request(request);
      assert.equal(first.disposition, "completed");
      assert.deepEqual(first.value, {
        decision: "allow",
        summary: "Synthetic decision; no model provider was called.",
      });
      assert.deepEqual(await h.broker.request(request), first);
    });
    test("changed input under an existing operation key conflicts", async () => {
      const h = await make();
      const request = await h.arrange("ai.decide");
      await h.broker.request(request);
      await assert.rejects(
        h.broker.request({ ...request, prompt: "Changed prompt" }),
        (e) => e instanceof RuntimeError && e.code === "CONFLICT",
      );
    });
    test("closed requests and revoked generations fail before provider dispatch", async () => {
      const h = await make();
      const request = await h.arrange("read");
      await assert.rejects(
        h.broker.request({
          ...request,
          endpoint: "https://invalid.example",
        } as BrokerRequest),
        (e) => e instanceof RuntimeError && e.code === "RESULT_INVALID",
      );
      await h.revoke(request.runId);
      await assert.rejects(
        h.broker.request(request),
        (e) => e instanceof RuntimeError && e.code === "REVOKED",
      );
    });
  });
}
