# PMCI Deployment (Caddy + Fastify)

## Overview

For **Fly.io** (PMCI API + observer Machines, TLS at the Fly edge), see [deployment-fly.md](deployment-fly.md).

Production deployments terminate TLS at Caddy and run the PMCI Fastify API on localhost. Local and development deployments can continue to use plain HTTP on `http://localhost:8787` without Caddy.

## Prerequisites

- A domain name pointed at your server (e.g. `api.yourdomain.com`)
- Caddy installed on the host
- Environment variables configured for TLS provisioning

## Environment

Set the following environment variables for production:

- `PMCI_HOST` — hostname for the PMCI API (e.g. `api.yourdomain.com`)
- `CADDY_ACME_EMAIL` — email address for Let's Encrypt ACME registration

These are referenced from the `Caddyfile` in the project root.

## Deployment Sequence

1. **Set environment variables**
   - `PMCI_HOST` to your API hostname (e.g. `api.yourdomain.com`)
   - `CADDY_ACME_EMAIL` to a valid email for TLS certificate provisioning

2. **Install Caddy**
   - Follow the official instructions: https://caddyserver.com/docs/install

3. **Start Caddy with the project Caddyfile**
   - From the project root, copy the `Caddyfile` to your server and run:
     - `caddy start --config Caddyfile`

4. **TLS provisioning**
   - Caddy will automatically request and renew TLS certificates from Let's Encrypt for `PMCI_HOST`.

5. **Run the PMCI API behind Caddy**
   - Ensure the Fastify API binds to localhost:
     - `app.listen({ port: PORT, host: "127.0.0.1" })` (instead of `0.0.0.0`) in production
   - Start the API with:
     - `npm run api:pmci`

6. **Verify**
   - Hit `https://$PMCI_HOST/v1/health/freshness` and confirm:
     - HTTPS is served by Caddy
     - `X-PMCI-Version` header is present

## Local / Development

For local or dev environments without a domain:

- You can run Fastify directly on `http://localhost:8787` without Caddy.
- TLS is not required; the `Caddyfile` is for production use only.

