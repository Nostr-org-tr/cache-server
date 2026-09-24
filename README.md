# `cache.nostr.org.tr`

> **High-Performance Pull-Through Cache Nostr Relay** built on Cloudflare Workers, Durable Objects (SQLite-backed WebSocket sessions), and Cloudflare D1.

[![CI](https://github.com/Nostr-org-tr/cache-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Nostr-org-tr/cache-server/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Vitest-3.0-green.svg?logo=vitest)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![SemVer](https://img.shields.io/badge/SemVer-2.0.0-orange.svg)](VERSIONING.md)

---

## 1. Overview & Vision

`cache.nostr.org.tr` is a regional edge-caching Nostr relay engineered to drastically minimize query latencies, reduce mobile bandwidth consumption, and offload read pressure from primary relays for Nostr web, desktop, and mobile clients across Turkey and neighboring regions.

### Key Capabilities
- ⚡ **Sub-Millisecond Edge Reads:** Instantly serves NIP-01 `REQ` filter queries from regional Cloudflare D1 SQLite replicas.
- 🔄 **Transparent Pull-Through Ingestion:** On local cache misses, concurrently queries an upstream pool (`relay.damus.io`, `nos.lol`, `relay.primal.net`, etc.), verifies cryptographic signatures, deduplicates records, streams matches in real time, and persists events asynchronously.
- 🛡️ **Cryptographic Verification (BIP-340):** All inbound events are verified using `@noble/curves/secp256k1` prior to storage. Mismatched hashes or invalid Schnorr signatures are dropped immediately.
- 🗄️ **Spec-Compliant Event Lifecycle:** Full enforcement of event replacement semantics (Kinds 0, 3, 10000–19999), parameterized replacements (Kinds 30000–39999), ephemeral event streaming (Kinds 20000–29999), and deletion handling (Kind 5 / NIP-09).
- 💤 **WebSocket Hibernation:** Uses Cloudflare Workers WebSocket Hibernation API within Durable Objects to maintain thousands of idle client sessions with minimal CPU and memory footprint.
- 🔒 **Read-Only Cache Mode:** Operates as a transparent pull-through cache. Direct client writes are rejected by default with NIP-20 `OK: false: blocked: cache relay is read-only` unless explicitly configured.

> [!IMPORTANT]
> **Current Scope & Usage Disclaimer:**
> `cache.nostr.org.tr` is currently best suited for **personal development, targeted event lookups, and simple single-subscription queries** (e.g. CLI tools like `nak`, metadata caching, and profile lookups).
> 
> It is **not currently recommended as a single, standalone read relay for complex client feed building** (e.g. web/mobile clients like Ditto, Coracle, or Snort that fire many concurrent multi-kind subscription queries to compile full timelines). Full upstream multiplexing and multi-subscription synchronization for heavy social feed clients are under ongoing development.

---

## 2. Architecture & Data Flow

```
+-----------------------------------------------------------------------------+
|                               Client Layer                                  |
|         (Nostr Web Apps / Mobile Clients / Desktop Clients / Bots)          |
+--------------------------------------+--------------------------------------+
                                       |
                   WebSocket Connection| / HTTP (NIP-11)
                                       v
+-----------------------------------------------------------------------------+
|                        Cloudflare Worker Entrypoint                         |
|                            (cache.nostr.org.tr)                             |
|                                                                             |
|  * HTTP Router: NIP-11 Document (/), Health (/health), Stats (/stats)       |
|  * WebSocket Upgrade Router -> Dispatches to Durable Object ClientSession   |
+--------------------------------------+--------------------------------------+
                                       |
                                       | Hibernatable WebSocket Binding
                                       v
+-----------------------------------------------------------------------------+
|                    Durable Object: ClientSession Class                      |
|                                                                             |
|  * Maintains Client WebSocket State & Active Subscriptions (sub_id)         |
|  * Inbound Message Parser (REQ, EVENT, CLOSE, COUNT)                        |
|  * Deduplication & Filter Match Engine                                      |
+-------------------+-------------------------------------+-------------------+
                    |                                     |
    (1) D1 Cache Query                                    | (2) Cache Miss / Fetch
    (Local SQLite Read)                                   | (Outbound WebSockets)
                    v                                     v
+-----------------------------------+   +-------------------------------------+
|        Cloudflare D1 DB           |   |       Upstream Relay Pool           |
|                                   |   |                                     |
| * Table: events (id, pubkey,      |   | * wss://relay.primal.net            |
|          kind, created_at, etc.)  |   | * wss://relay.damus.io              |
| * Table: event_tags (tag indexing)|   | * wss://relay.nostr.band            |
+-------------------+---------------+   +------------------+------------------+
                    |                                      |
                    | (Found Events)                       | (Streamed Events)
                    \-----------------\  /----------------/
                                       v v
+-----------------------------------------------------------------------------+
|                         Client WebSocket Response                           |
|       ["EVENT", sub_id, { ... }] -> ["EOSE", sub_id]                        |
+-----------------------------------------------------------------------------+
```

---

## 3. Nostr Protocol (NIP) Support Matrix

| NIP | Specification Description | Support Status |
| :--- | :--- | :---: |
| **[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)** | Basic protocol flow (`EVENT`, `REQ`, `CLOSE`, `EOSE`, `OK`, `NOTICE`) | ✅ Full |
| **[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)** | Event Deletion (`kind: 5`) with pubkey ownership verification | ✅ Full |
| **[NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md)** | Relay Information Document (`application/nostr+json`) & CORS | ✅ Full |
| **[NIP-16](https://github.com/nostr-protocol/nips/blob/master/16.md)** | Ephemeral (20k–29k) & Replaceable (10k–19k) Event Semantics | ✅ Full |
| **[NIP-20](https://github.com/nostr-protocol/nips/blob/master/20.md)** | Command Results (`["OK", event_id, true/false, reason]`) | ✅ Full |
| **[NIP-33](https://github.com/nostr-protocol/nips/blob/master/33.md)** | Parameterized Replaceable Events (`kind: 30000..39999` with `d` tag) | ✅ Full |
| **[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md)** | Relay List Metadata parsing & dynamic upstream routing | ✅ Full |

---

## 4. Quickstart & Local Development

### 4.1 Prerequisites
- [Node.js](https://nodejs.org/) (>= v20.0.0, loaded via `.nvmrc`).
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as dev dependency).

### 4.2 Installation & Startup
```bash
# 1. Clone repository
git clone https://github.com/Nostr-org-tr/cache-server.git
cd cache-server

# 2. Install dependencies (loads .nvmrc automatically)
make install

# 3. Apply local D1 SQLite schema migrations
make db-migrate-local

# 4. Start local development server with Durable Objects emulation
make dev
```
The local server will be accessible at `http://localhost:8787` and `ws://localhost:8787`.

---

## 5. Canonical Makefile Command Reference

All build, testing, migration, and release commands are centralized in the `Makefile`:

```bash
make install             # Install dependencies with active nvm node version
make dev                 # Start local Cloudflare Workers dev runtime
make build               # Typecheck & dry-run bundle build
make test                # Execute full Vitest test suite (217 tests)
make bench               # Execute micro-benchmarks and load simulations
make lint                # Run version consistency check and TypeScript compiler
make all                 # Execute lint, test, and build in sequence
make db-create           # Create the Cloudflare D1 database via Wrangler
make db-migrate-local    # Apply SQL migrations to local SQLite environment
make db-migrate-remote   # Apply SQL migrations to remote production Cloudflare D1
make cache-prune-remote-all       # Flush remote production cache (preserves operator rules)
make cache-prune-remote-moderated # Sweep & purge NSFW/muted events from remote D1
make cache-prune-remote-gc        # Run TTL garbage collection on remote D1
make cache-prune-remote-dry-run   # Audit remote production D1 row counts
make cache-prune-local-all        # Flush local development cache
make cache-prune-local-moderated  # Purge NSFW/muted events from local D1
make version-check       # Verify SemVer sync across package.json and src/version.ts
make version-patch       # Bump patch version (1.2.0 -> 1.2.1) across all files
make version-minor       # Bump minor version (1.2.0 -> 1.3.0) across all files
make version-major       # Bump major version (1.2.0 -> 2.0.0) across all files
make deploy              # Deploy Worker & Durable Objects to Cloudflare
make tail                # Stream real-time edge logs from production
make clean               # Remove dist/, .wrangler/, and build artifacts
```

---

## 6. Configuration Reference (`wrangler.jsonc`)

| Variable / Binding | Type | Description |
| :--- | :--- | :--- |
| `DB` | D1 Database | Cloudflare D1 SQLite database binding (`nostr_cache_db`). |
| `CLIENT_SESSION` | Durable Object | SQLite-backed `ClientSession` class for WebSocket state. |
| `RELAY_NAME` | string | Human-readable relay name exposed in NIP-11 document. |
| `RELAY_DESCRIPTION` | string | Relay description in NIP-11 document. |
| `RELAY_PUBKEY` | string | Hex pubkey of the relay operator. |
| `RELAY_CONTACT` | string | Contact URI or email for the relay operator. |
| `UPSTREAM_RELAYS` | csv string | Comma-separated list of fallback upstream relays for pull-through. |
| `UPSTREAM_TIMEOUT_MS` | number | Timeout (ms) for upstream relay fetch operations (default: `5000`). |
| `ALLOW_DIRECT_WRITES` | boolean | Set to `"true"` to accept direct client writes, `"false"` for read-only cache. |
| `RATE_LIMIT_MSG_PER_WINDOW`| number | Max allowed WebSocket messages per sliding time window. |

---

## 7. Production Endpoints

| Endpoint | Protocol | Description |
| :--- | :--- | :--- |
| `https://cache.nostr.org.tr/` | HTTP (NIP-11) | NIP-11 Relay Information Document (`Accept: application/nostr+json`). |
| `wss://cache.nostr.org.tr/` | WebSocket | Nostr NIP-01 WebSocket Relay endpoint. |
| `https://cache.nostr.org.tr/health` | HTTP JSON | Automated health check endpoint (D1 status, version, uptime). |
| `https://cache.nostr.org.tr/stats` | HTTP JSON | Edge cache performance metrics & cached event counts. |

---

## 8. Verification & CLI Usage

### Testing with `nak`
```bash
# Query latest 5 text notes
nak req -k 1 -l 5 wss://cache.nostr.org.tr

# Query events from a specific pubkey
nak req -a <pubkey_hex> wss://cache.nostr.org.tr

# Fetch NIP-11 Relay document
curl -H "Accept: application/nostr+json" https://cache.nostr.org.tr/
```

### Automated Live Verification Script
```bash
npm run verify:live -- --url https://cache.nostr.org.tr
```

---

## 9. Community & Contributing

- **Contributing Guidelines:** Please see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
- **Code of Conduct:** We adhere to the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md).
- **Security Inquiries:** For vulnerability disclosures, refer to [SECURITY.md](SECURITY.md) or contact [admin@nostr.org.tr](mailto:admin@nostr.org.tr).
- **Deployment & Ops Runbook:** See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Release & Versioning:** See [VERSIONING.md](VERSIONING.md).

---

## 10. License

This project is licensed under the [MIT License](LICENSE) &copy; 2026 Emre YILMAZ & Nostr Turkey Community.
