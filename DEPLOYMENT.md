# Production Deployment & Operations Runbook

> Operational manual for deploying, maintaining, and monitoring `cache.nostr.org.tr` on Cloudflare Workers, SQLite-backed Durable Objects, and Cloudflare D1.

---

## 1. Prerequisites & Account Setup

1. **Cloudflare Account & Tier Requirements:**
   - Active Cloudflare account with the domain `nostr.org.tr` active in DNS.
   - Workers Paid subscription (required for Durable Objects).
2. **Local Environment:**
   - Node.js LTS (>= v20.0.0, managed via `.nvmrc`).
   - Wrangler CLI authenticated via `npx wrangler login` or `CLOUDFLARE_API_TOKEN`.

---

## 2. Infrastructure Architecture & Bindings

`cache.nostr.org.tr` utilizes the following Cloudflare services:

| Resource | Binding Name | Target Identifier / Class | Description |
| :--- | :--- | :--- | :--- |
| **D1 Database** | `DB` | `nostr_cache_db` (`6009d0a9-1d83-4c6b-a741-f6f4326e8102`) | Primary SQLite storage for events and tags index. |
| **Durable Object** | `CLIENT_SESSION` | `ClientSession` (`new_sqlite_classes`) | Manages stateful client WebSocket sessions & upstream proxying. |
| **Custom Domain** | N/A | `cache.nostr.org.tr` | Anycast edge routing + automated TLS certificate. |

---

## 3. Step-by-Step Deployment Procedure

### Step 3.1: Environment Verification
Ensure you are using the correct Node.js runtime and dependencies:
```bash
make install
```

### Step 3.2: Remote D1 Database Migrations
Apply the initial schema (`migrations/0001_initial_schema.sql`) to the remote production D1 database:
```bash
make db-migrate-remote
```

### Step 3.3: Typecheck & Full Test Suite Execution
Before deploying, ensure all linting, typechecking, and unit/integration/benchmark tests pass:
```bash
make all
```

### Step 3.4: Deploy Worker & Durable Objects
Deploy the bundle to Cloudflare's global edge network:
```bash
make deploy
```
*Note: Wrangler will automatically configure the `cache.nostr.org.tr` custom domain route and apply the `v1` `new_sqlite_classes` migration for `ClientSession`.*

---

## 4. Post-Deployment Verification

### 4.1 Automated Protocol & Latency Suite
Run the automated verification script directly against the live edge deployment:
```bash
npm run verify:live -- --url https://cache.nostr.org.tr
```
This suite automatically tests:
- HTTP NIP-11 Relay Document schema, status, and CORS headers.
- HTTP `/health` and `/stats` endpoints.
- WebSocket handshake and NIP-01 `REQ` / `EOSE` / `CLOSE` protocol lifecycle.
- Cryptographic event ingest, BIP-340 Schnorr signature validation, and immediate D1 cache readback.
- Edge turnaround latency.

### 4.2 CLI Verification with `nak`
To query live events using standard Nostr tooling:
```bash
# Query latest 5 text notes
nak req -k 1 -l 5 wss://cache.nostr.org.tr

# Publish a test note
nak event -c "Hello from Nostr Turkey Cache Relay!" wss://cache.nostr.org.tr
```

---

## 5. Operations, Monitoring & Observability

### 5.1 Real-Time Edge Log Streaming
To monitor live requests, WebSocket connections, and upstream pull-through events:
```bash
make tail
```

### 5.2 Health & Telemetry Endpoints
- **Health Check:** `GET https://cache.nostr.org.tr/health`
  - Returns `{ "status": "ok", "database": "healthy", "timestamp": ... }`
- **Relay Statistics:** `GET https://cache.nostr.org.tr/stats`
  - Returns total cached event counts and uptime metrics.
- **NIP-11 Document:** `GET https://cache.nostr.org.tr/` with header `Accept: application/nostr+json`

---

## 6. Rollback & Disaster Recovery

### Rollback Previous Deployment
In the event of a regression, rollback to the previous Worker version:
```bash
npx wrangler rollback
```

### D1 Database Backup & Export
To export the remote D1 SQLite database:
```bash
npx wrangler d1 export nostr_cache_db --remote --output backup.sql
```
