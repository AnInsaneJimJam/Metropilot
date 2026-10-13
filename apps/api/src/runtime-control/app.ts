import { ControlError } from '../control.ts';
import { PaperBrokerService } from '../broker-service.ts';
// Internal runtime-facing HTTP API (docs/specs/agent-runtime.md §7, docs/integration/control-api.md §5).
// Two credentials: workload identity for the assignment poll (pluggable; the selected mechanism is gate E02),
// and a per-assignment bearer capability for everything else. A capability authorizes exactly one assignment
// of one run; the store then fences every write by lease and generation inside its transaction.
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validate } from '@monad-hack/contracts';
import type { ContractKind } from '@monad-hack/contracts';
import { RunControlError, uuidv7 } from './store.ts';
import type { CapabilityScope, RuntimeControlStore } from './store.ts';

export interface InternalAppOptions {
  readonly store: RuntimeControlStore;
  readonly broker?: PaperBrokerService;
  /** Resolve the calling runtime from workload authentication; undefined refuses the poll. */
  readonly authenticateWorkload: (headers: FastifyRequest['headers']) => string | undefined;
  /** Delay between assignment checks while a long-poll is held open (no connection is held while waiting). */
  readonly pollIntervalMillis?: number;
}

const RUN_ID = /^0x[0-9a-f]{64}$/;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createInternalApp(options: InternalAppOptions) {
  const { store } = options;
  const pollInterval = options.pollIntervalMillis ?? 250;
  const app = Fastify({ bodyLimit: 320 * 1024, logger: false, genReqId: uuidv7, requestIdHeader: false });

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof RunControlError || error instanceof ControlError;
    const fastify = error as { statusCode?: number; code?: unknown };
    // Only a lost or refused database connection is a retryable outage; anything else is a defect.
    const outage = !known && typeof fastify.code === 'string' && (/^(08|57P0)/.test(fastify.code) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(fastify.code));
    const status = known ? error.status : fastify.statusCode && fastify.statusCode < 500 ? fastify.statusCode : outage ? 503 : 500;
    const code = known ? error.code : status === 413 ? 'LIMIT_EXCEEDED' : status < 500 ? 'MALFORMED_REQUEST' : outage ? 'PROVIDER_UNAVAILABLE' : 'INTERNAL_ERROR';
    // Safe, bounded messages only; internal errors never echo their cause.
    const message = known ? error.message : status < 500 ? 'The request does not match the required format.' : outage ? 'The control database is unavailable.' : 'Internal error.';
    void reply.code(status).header('cache-control', 'no-store').send({ code, message, requestId: request.id, retryable: outage });
  });

  const refuse = (status: 401 | 403, message: string): never => {
    throw new RunControlError(status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', message);
  };
  const body = <K extends ContractKind>(kind: K, value: unknown) => {
    const result = validate(kind, value);
    if (!result.ok) throw new RunControlError('SCHEMA_INVALID', `Malformed ${kind} at ${result.issues[0]?.fieldPath || '/'}.`);
    return result.value;
  };
  const capability = async (request: FastifyRequest): Promise<{ scope: CapabilityScope; bearer: string }> => {
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const scope = bearer ? await store.authenticate(bearer) : undefined;
    if (!scope) return refuse(401, 'A valid assignment capability is required.');
    return { scope, bearer };
  };
  /** The capability names one assignment of one run; every identifier in the request must match it. */
  const sameRun = (scope: CapabilityScope, runId: string, assignmentId: string): void => {
    if (!RUN_ID.test(runId) || scope.runId !== runId || scope.assignmentId !== assignmentId) refuse(403, 'This capability does not cover that run or assignment.');
  };
  const noContent = (reply: FastifyReply) => reply.code(204).header('cache-control', 'no-store').send();

  app.post('/internal/v1/runtime/assignments::poll', async (request, reply) => {
    const runtimeId = options.authenticateWorkload(request.headers);
    if (!runtimeId) return refuse(401, 'Workload authentication is required.');
    const poll = body('assignmentPoll', request.body);
    if (poll.runtimeId !== runtimeId) refuse(403, 'Poll identity does not match the authenticated workload.');
    const deadline = Date.now() + poll.waitSeconds * 1000;
    for (;;) {
      const offer = await store.poll(poll);
      if (offer.disposition !== 'none' || Date.now() >= deadline) return reply.header('cache-control', 'no-store').send(offer);
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  });

  app.get('/internal/v1/runtime/artifacts/:ref', async (request, reply) => {
    const { scope } = await capability(request);
    const { ref } = request.params as { ref: string };
    const artifact = await store.artifact(ref);
    // Another deployment's artifact is indistinguishable from a missing one.
    if (artifact.deploymentId !== scope.deploymentId) throw new RunControlError('NOT_FOUND', 'Unknown artifact reference.');
    const { deploymentId: _owner, ...document } = artifact;
    return reply.header('cache-control', 'no-store').send(document);
  });

  app.post('/internal/v1/market/read', async (request, reply) => {
    const { scope } = await capability(request);
    return reply.header('cache-control', 'no-store').send(await store.marketRead(scope, body('brokerRequest', request.body)));
  });

  app.get('/internal/v1/runs/:runId', async (request, reply) => {
    const { scope } = await capability(request);
    const { runId } = request.params as { runId: string };
    const { assignmentId = '', fencingToken = '' } = request.query as { assignmentId?: string; fencingToken?: string };
    if (!UUIDV7.test(assignmentId) || !/^[1-9][0-9]{0,18}$/.test(fencingToken)) throw new RunControlError('SCHEMA_INVALID', 'assignmentId and fencingToken query parameters are required.');
    sameRun(scope, runId, assignmentId);
    return reply.header('cache-control', 'no-store').send(await store.loadRun(runId, assignmentId, fencingToken));
  });

  const runWrite = (path: string, kind: 'runWait' | 'runResult' | 'runComplete' | 'timelineEntry', write: (doc: never) => Promise<void>) => {
    app.post(`/internal/v1/runs/:runId/${path}`, async (request, reply) => {
      const { scope } = await capability(request);
      const doc = body(kind, request.body) as { runId: string; assignmentId: string };
      sameRun(scope, (request.params as { runId: string }).runId, doc.assignmentId);
      if (doc.runId !== scope.runId) refuse(403, 'Body run does not match the route.');
      await write(doc as never);
      return noContent(reply);
    });
  };
  runWrite('wait', 'runWait', (doc) => store.wait(doc));
  runWrite('results', 'runResult', (doc) => store.result(doc));
  runWrite('complete', 'runComplete', (doc) => store.complete(doc));
  runWrite('timeline', 'timelineEntry', (doc) => store.timeline(doc));

  // Exchange the control capability for an executor-audience capability (D38). The runtime never holds
  // the signing secret; the token is scoped to this run and expires with (or before) the control capability.
  app.post('/internal/v1/runtime/capabilities::exchange', async (request, reply) => {
    const { scope } = await capability(request);
    const asked = request.body as { audience?: unknown } | null;
    if (!asked || typeof asked !== 'object' || Object.keys(asked).join() !== 'audience' || (asked.audience !== 'executor' && asked.audience !== 'broker')) {
      throw new RunControlError('SCHEMA_INVALID', 'Ask for exactly one supported audience: executor or broker.');
    }
    return reply.header('cache-control', 'no-store').send(await store.issueAudienceCapability(scope, asked.audience as 'executor' | 'broker'));
  });

  app.post('/internal/v1/runtime/heartbeat', async (request, reply) => {
    const { scope, bearer } = await capability(request);
    const beat = body('runtimeHeartbeat', request.body);
    sameRun(scope, beat.runId, beat.assignmentId);
    const renewed = await store.heartbeat(beat.assignmentId, beat.fencingToken);
    return reply.header('cache-control', 'no-store').send({ schemaVersion: 'runtime-lease/1', leaseExpiresAt: renewed.leaseExpiresAt, capability: { bearer, expiresAt: renewed.capabilityExpiresAt } });
  });

  if (options.broker) {
    const broker = options.broker;
    app.post('/internal/v1/broker/requests', async (request, reply) => {
      const doc = body('brokerRequest', request.body);
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const result = await broker.request(bearer, doc);
      return reply.code(result.disposition === 'pending' || result.disposition === 'unknown' ? 202 : 200).header('cache-control', 'no-store').send(result);
    });
  }
  return app;
}
