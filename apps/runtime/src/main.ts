import { HttpBroker } from './dispatch/broker.ts';
// Runtime process entry: closed configuration (refuses credential-shaped variables), HTTP clients for the
// control API and executor, the HTTP API broker and the warm supervisor
// loop. SIGTERM/SIGINT drain: no new step or dispatch, then exit. Paper only.
import { parseConfig, parseEndpoints } from './config.ts';
import { HttpControlApi } from './dispatch/control-api.ts';
import { HttpExecutor } from './dispatch/executor.ts';
import { systemClock } from './ports.ts';
import { Supervisor } from './supervisor.ts';
import { Telemetry } from './telemetry.ts';

const config = parseConfig(process.env);
const endpoints = parseEndpoints(process.env, config.mode);
if (!endpoints.devWorkloadHeader) throw new Error('No workload identity mechanism is configured (gate E02); set RUNTIME_DEV_WORKLOAD=1 on loopback.');
const control = new HttpControlApi({ origin: endpoints.controlApiOrigin, workload: { 'x-runtime-workload': config.runtimeId } });
const executor = new HttpExecutor({ origin: endpoints.executorOrigin, capability: () => control.executorCapability(), forgetCapability: () => control.forgetExecutorCapability() });
if (endpoints.broker !== 'http') throw new Error('The running stack requires the HTTP API Broker.');
const broker = new HttpBroker({ origin: endpoints.brokerOrigin, capability: () => control.brokerCapability(), forgetCapability: () => control.forgetBrokerCapability() });
const telemetry = new Telemetry({ write: (event) => console.log(JSON.stringify(event)) });
const supervisor = new Supervisor({ config, control, broker, executor, clock: systemClock, telemetry });
process.on('SIGTERM', () => supervisor.drain());
process.on('SIGINT', () => supervisor.drain());
console.log(`Runtime ${config.runtimeId} serving (${config.mode}, ${endpoints.broker} broker)`);
await supervisor.serve();
process.exit(0);
