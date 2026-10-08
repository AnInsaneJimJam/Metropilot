// Internal HTTP boundary (docs/specs/executor.md section 3). Fixed route table, closed JSON in and out,
// error-1 failure bodies. No route accepts bytes to sign. Logs carry IDs and statuses, never headers or bodies.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { maxDocumentBytes, validate } from '@monad-hack/contracts';
import type { ErrorBody } from '@monad-hack/contracts';
import { uuidv7, UUIDV7 } from './ids.ts';
import type { Readiness } from './readiness.ts';
import type { Failure, Reply } from './service.ts';
import type { ExecutorService } from './service.ts';

export interface LogEntry {
  readonly requestId: string;
  readonly route: string;
  readonly status: number;
  readonly millis: number;
  readonly reason?: string;
}

export interface ServerOptions {
  readonly service: ExecutorService;
  readonly readiness: () => Promise<Readiness>;
  readonly log?: (entry: LogEntry) => void;
}

const INTENT_PATH = /^\/internal\/v1\/intents\/([^/]+)$/;

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function errorBody(failure: Failure, requestId: string): ErrorBody {
  const body: ErrorBody = { code: failure.code, message: failure.message, requestId, retryable: failure.status === 503 };
  if (failure.fieldPath !== undefined) body.fieldPath = failure.fieldPath;
  if (failure.reason) body.details = { reason: failure.reason };
  return body;
}

export function createExecutorServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    const started = performance.now();
    const header = req.headers['x-request-id'];
    const callerId = typeof header === 'string' && UUIDV7.test(header) ? header : undefined;
    const requestId = callerId ?? uuidv7();
    let route = 'unknown';
    const finish = (status: number, body: unknown, reason?: string): void => {
      send(res, status, body);
      options.log?.({ requestId, route, status, millis: Math.round(performance.now() - started), ...(reason ? { reason } : {}) });
    };
    const failWith = (failure: Failure): void => finish(failure.status, errorBody(failure, requestId), failure.reason ?? failure.code);
    const reply = (answer: Reply): void => {
      if ('failure' in answer) return failWith(answer.failure);
      // Defense in depth: never emit a result that is not a closed intent-result/1.
      if (!validate('intentResult', answer.result).ok) return finish(500, errorBody({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'Executor produced an invalid result.' }, requestId), 'RESULT_INVALID');
      finish(answer.status, answer.result, answer.result.reason?.code);
    };

    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://executor.internal');
      if (url.pathname === '/internal/v1/intents') {
        route = 'POST /internal/v1/intents';
        if (req.method !== 'POST') return failWith({ status: 400, code: 'MALFORMED_REQUEST', message: 'Use POST for this route.' });
        if (!callerId) return failWith({ status: 400, code: 'MALFORMED_REQUEST', message: 'X-Request-ID must be a UUIDv7.' });
        if (!/^application\/json(;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
          return failWith({ status: 400, code: 'MALFORMED_REQUEST', message: 'Content-Type must be application/json.' });
        }
        let body: string;
        try {
          body = await readBody(req, maxDocumentBytes.actionIntent);
        } catch (error) {
          if (error instanceof BodyTooLarge) return failWith({ status: 400, code: 'LIMIT_EXCEEDED', message: 'The intent body is too large.' });
          throw error;
        }
        const key = req.headers['idempotency-key'];
        return reply(await options.service.submit({ authorization: req.headers.authorization, idempotencyKey: typeof key === 'string' ? key : undefined, body }));
      }
      const match = INTENT_PATH.exec(url.pathname);
      if (match) {
        route = 'GET /internal/v1/intents/{intentId}';
        if (req.method !== 'GET') return failWith({ status: 400, code: 'MALFORMED_REQUEST', message: 'Use GET for this route.' });
        return reply(await options.service.status(req.headers.authorization, match[1]!));
      }
      if (url.pathname === '/internal/v1/readiness' && req.method === 'GET') {
        route = 'GET /internal/v1/readiness';
        const readiness = await options.readiness();
        return finish(readiness.paper.ready ? 200 : 503, readiness);
      }
      failWith({ status: 404, code: 'NOT_FOUND', message: 'No such route.' });
    };

    handle().catch(() => {
      // Unexpected defect or dependency failure; nothing secret or provider-specific leaves the process.
      if (!res.headersSent) finish(503, errorBody({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'The executor could not complete the request; retry with the same body and key.', reason: 'EXECUTOR_PROVIDER_UNAVAILABLE' }, requestId), 'EXECUTOR_PROVIDER_UNAVAILABLE');
      else res.destroy();
    });
  });
}
