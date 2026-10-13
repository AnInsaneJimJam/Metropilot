// Runtime task sidecar (hosted only). The runtime accepts plain http only on loopback and names itself with the
// development workload header, so each runtime task runs this proxy beside it:
//   127.0.0.1:3002 → control API (adds the workload HMAC proof), 127.0.0.1:3003 → executor (pass-through).
// The workload ID is bound to the ECS task (runtime-<task id> from the task metadata endpoint); a request naming
// another workload is refused. The proxy holds RUNTIME_WORKLOAD_SECRET; the runtime container holds no secret.
import { createHmac } from 'node:crypto';
import http from 'node:http';

const secretHex = process.env.RUNTIME_WORKLOAD_SECRET ?? '';
if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('RUNTIME_WORKLOAD_SECRET must be 64 lower-case hex characters.');
const key = Buffer.from(secretHex, 'hex');
const upstream = (name) => {
  const url = new URL(process.env[name] ?? '');
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.password) throw new Error(`${name} must be a bare http:// origin on the private network.`);
  return url;
};
const control = upstream('CONTROL_UPSTREAM');
const executor = upstream('EXECUTOR_UPSTREAM');

async function workloadId() {
  if (process.env.WORKLOAD_ID) return process.env.WORKLOAD_ID;
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) throw new Error('No ECS task metadata endpoint; set WORKLOAD_ID.');
  const task = await (await fetch(`${base}/task`)).json();
  return `runtime-${String(task.TaskARN).split('/').pop()}`;
}
const id = await workloadId();
const proof = createHmac('sha256', key).update(id).digest('hex');

function serve(port, target, sign) {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host };
    if (sign) {
      if (req.headers['x-runtime-workload'] !== undefined && req.headers['x-runtime-workload'] !== id) {
        res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"Workload identity is bound to this task."}');
        return;
      }
      headers['x-runtime-workload'] = id;
      headers['x-runtime-workload-proof'] = proof;
    } else {
      delete headers['x-runtime-workload-proof'];
    }
    const out = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers, timeout: 60_000 }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on('timeout', () => out.destroy(new Error('upstream timeout')));
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"message":"Upstream unavailable."}');
    });
    req.pipe(out);
  });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'workload.proxy.listening', port, upstream: target.origin, signed: sign })));
  return server;
}

const servers = [serve(3002, control, true), serve(3003, executor, false)];
const stop = () => {
  for (const s of servers) s.close();
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
