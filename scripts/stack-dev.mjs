// Local paper stack: user API (3001), runtime-facing control API + worker (3002), paper executor (3003),
// one runtime process and the web studio (5173). Development only, loopback; mainnet data and simulated effects.
// The executor capability secret is generated per run and shared only by the control API and executor;
// the runtime starts with a clean environment (it refuses database URLs, secrets and provider keys).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const env = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && env[match[1]] === undefined) env[match[1]] = match[2];
  }
}
const secret = env.EXECUTOR_CAPABILITY_SECRET || randomBytes(32).toString('hex');
const brokerSecret = env.BROKER_CAPABILITY_SECRET || randomBytes(32).toString('hex');
const image = env.RUNTIME_IMAGE_DIGEST || '0x' + '5a'.repeat(32);
const node = process.execPath;
const services = [
  ['api', ['apps/api/src/server.ts'], { ...env, LOCAL_WORKSPACE: '1', RUNTIME_IMAGE_DIGEST: image, CUSTODY_PROVIDER: env.CUSTODY_PROVIDER ?? 'local' }],
  ['control', ['apps/api/src/runtime-control/server.ts'], { ...env, LOCAL_RUNTIME_CONTROL: '1', EXECUTOR_CAPABILITY_SECRET: secret, BROKER_CAPABILITY_SECRET: brokerSecret }],
  ['executor', ['apps/executor/src/main.ts'], { ...env, LOCAL_EXECUTOR: '1', EXECUTOR_CAPABILITY_SECRET: secret }],
  // Clean environment: only what the runtime's closed configuration accepts.
  ['runtime', ['apps/runtime/src/main.ts'], {
    PATH: env.PATH ?? '', HOME: env.HOME ?? '', RUNTIME_ID: 'runtime-local-1', RUNTIME_MODE: 'paper', RUNTIME_IMAGE_DIGEST: image,
    RUNTIME_CONTROL_API_ORIGIN: 'http://127.0.0.1:3002', RUNTIME_EXECUTOR_ORIGIN: 'http://127.0.0.1:3003', RUNTIME_DEV_WORKLOAD: '1',
  }],
];
const children = [];
const prefix = (name, stream) => (chunk) => {
  for (const line of chunk.toString().split('\n')) if (line) stream.write(`[${name}] ${line}\n`);
};
const start = (name, command, args, childEnv, delay = 0) => setTimeout(() => {
  const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', prefix(name, process.stdout));
  child.stderr.on('data', prefix(name, process.stderr));
  child.on('exit', (code) => { console.log(`[${name}] exited ${code}`); shutdown(code ?? 1); });
  children.push(child);
}, delay);
let stopping = false;
const shutdown = (code) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('Local paper stack: Monad mainnet native oracles, virtual inventory, simulated fills. Open http://127.0.0.1:5173');
services.forEach(([name, args, childEnv], i) => start(name, node, args, childEnv, name === 'runtime' ? 1500 : i * 100));
start('web', 'pnpm', ['--filter', '@monad-hack/web', 'dev'], env, 300);
