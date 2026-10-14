#!/usr/bin/env node
// Loopback forwarder for single-machine runtimes (infra/stack): the runtime keeps talking to 127.0.0.1:3002/3003 (its
// endpoint rules allow plain HTTP only on loopback), and this forwards each port to the workload proxy on the runtime's
// private network. The runtime container joins only that network, so it cannot reach Postgres or any other service.
//   node infra/sidecar/loopback-forward.mjs <proxy-ip> 3002 3003
import net from 'node:net';

const [host, ...ports] = process.argv.slice(2);
if (!host || !net.isIP(host) || !ports.length) throw new Error('usage: loopback-forward.mjs <proxy-ip> <port>...');
for (const port of ports.map(Number)) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
  net.createServer((client) => {
    const upstream = net.connect({ host, port });
    client.pipe(upstream).pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close);
    upstream.on('error', close);
  }).listen(port, '127.0.0.1');
}
