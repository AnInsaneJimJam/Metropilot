# Lightsail hosting

One-server hosting for the demo (docs/hosting/LIGHTSAIL.md): Terraform for the instance, static IP, firewall and key;
docker compose for the stack; `render-env.mjs` writes the server env without printing values; `up.sh` builds, ships
and starts. Never commit `terraform.tfvars`, `.env.server` or state. Real-money switches stay off unless the user
approves a capped live trade. Teardown steps are in the guide; keep them current with every resource added here.
