import { maxDocumentBytes, parse } from '@monad-hack/contracts';
import type { BrokerRequest, BrokerResult } from '@monad-hack/contracts';
import type { Broker } from '../ports.ts';
import { RuntimeError } from '../errors.ts';
import { runtimeErrorFor } from './errors.ts';
import { uuidv7 } from './ids.ts';

export interface HttpBrokerOptions {
  origin: string;
  capability: (request: BrokerRequest) => Promise<string>;
  forgetCapability?: () => void;
  attempts?: number;
  /** Tests may shorten the timeout; callers cannot exceed the protocol ceiling. */
  timeoutMillis?: number;
  fetch?: typeof globalThis.fetch;
}

/** Timeouts may conceal a dispatched call. Every retry carries the same serialized body and operation key. */
export class HttpBroker implements Broker {
  readonly origin: string;
  readonly options: HttpBrokerOptions;
  constructor(options: HttpBrokerOptions) {
    const url = new URL(options.origin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)))
      throw new RuntimeError('ASSIGNMENT_INVALID', 'Broker must use a bare HTTPS origin outside loopback.');
    if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 3))
      throw new RuntimeError('ASSIGNMENT_INVALID', 'Broker attempts must be between one and three.');
    if (options.timeoutMillis !== undefined && (!Number.isInteger(options.timeoutMillis) || options.timeoutMillis < 1))
      throw new RuntimeError('ASSIGNMENT_INVALID', 'Broker timeout must be a positive integer.');
    this.origin = url.origin; this.options = options;
  }
  async request(request: BrokerRequest): Promise<BrokerResult> {
    const body = JSON.stringify(request);
    if (!parse('brokerRequest', body).ok) throw new RuntimeError('RESULT_INVALID', 'Refusing a malformed broker request.');
    const ceiling = request.kind === 'read' ? 10_000 : (request.timeoutSeconds! + 5)*1000;
    const timeout = Math.min(this.options.timeoutMillis ?? ceiling, ceiling);
    const attempts = this.options.attempts ?? 3;
    let refreshed = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(`${this.origin}/internal/v1/broker/requests`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': uuidv7(), authorization: `Bearer ${await this.options.capability(request)}` }, body,
        });
        const text = await boundedText(response);
        if (response.status === 200 || response.status === 201 || response.status === 202) {
          const checked = parse('brokerResult', text);
          if (!checked.ok || checked.value.operationKey !== request.operationKey) throw new RuntimeError('RESULT_INVALID', 'Broker answer does not match its contract or operation.');
          return checked.value;
        }
        if (response.status === 401 && !refreshed && this.options.forgetCapability) {
          refreshed = true; this.options.forgetCapability(); attempt--; continue;
        }
        const error = parse('error', text);
        if (!error.ok) throw new RuntimeError('RESULT_INVALID', 'Broker error answer does not match its contract.');
        throw runtimeErrorFor(response.status, error.value.code);
      } catch (error) {
        if (error instanceof RuntimeError && error.code !== 'UNAVAILABLE') throw error;
        if (attempt === attempts - 1) throw new RuntimeError('UNAVAILABLE', 'Broker unreachable or timed out; retain the same operation key.');
      }
      await new Promise(resolve => setTimeout(resolve, 50*2**attempt + Math.random()*50));
    }
    throw new RuntimeError('UNAVAILABLE', 'Broker unavailable.');
  }
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxDocumentBytes.brokerResult) {
        await reader.cancel(); throw new RuntimeError('RESULT_INVALID', 'Broker response exceeds its byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}
