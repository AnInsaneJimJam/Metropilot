# Runtime task sidecar

The workload proxy runs beside each hosted runtime: loopback `127.0.0.1:3002/3003` → control API / executor on the
private network. It binds the workload ID to the ECS task and adds the HMAC proof the hosted control API checks.
It holds `RUNTIME_WORKLOAD_SECRET`; the runtime container never does. Keep it dependency-free (Node built-ins only)
and never log headers or bodies.

## Checklist

- [ ] Hosted negative test: a runtime naming another workload ID is refused (issue #27).
