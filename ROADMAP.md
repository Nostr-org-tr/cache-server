# Roadmap & Architecture Specification: `cache.nostr.org.tr`

> High-Performance Pull-Through Cache Nostr Relay on Cloudflare Workers, Durable Objects, and Cloudflare D1.

---

## 1. System Vision & Purpose

`cache.nostr.org.tr` is a regional edge-caching Nostr relay designed to drastically reduce latency, bandwidth overhead, and load for Nostr web, desktop, and mobile clients operating in and around Turkey and adjacent regions.

### Core Objectives
1. **Edge-Accelerated Queries:** Respond to NIP-01 filter subscriptions instantly from regional Cloudflare D1 SQLite replicas.
2. **Transparent Pull-Through Caching:** On local cache misses, transparently pull events from an upstream relay pool (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`), deduplicate them, verify signatures, stream them immediately to the client, and persist them asynchronously for subsequent callers.
3. **Spec-Compliant Event Lifecycle:** Strict enforcement of NIP-01, NIP-16, and NIP-33 event immutability, replacement, and parameterized replacement rules.
4. **Resilient Connection Model:** Utilize Cloudflare Durable Objects to maintain stateful client WebSocket sessions and orchestrate ephemeral upstream connections without blocking edge worker execution.

---

## 2. System Architecture

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
|  * HTTP Router: NIP-11 Relay Information, Health Checks (/health), Metrics  |
|  * WebSocket Upgrade Router -> Dispatches to Durable Object ClientSession   |
+--------------------------------------+--------------------------------------+
                                       |
                                       | Hibernatable WebSocket Binding
                                       v
+-----------------------------------------------------------------------------+
|                    Durable Object: ClientSession Class                      |
|                                                                             |
|  * Maintains Client WebSocket State & Active Subscription Table (sub_id)    |
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
| * Table: events (id, pubkey,      |   | * wss://relay.damus.io              |
|          kind, created_at, etc.)  |   | * wss://nos.lol                     |
| * Table: event_tags (tag indexing)|   | * wss://relay.nostr.band            |
+-------------------+---------------+   +------------------+------------------+
                    |                                      |
                    | (Found Events)                       | (Streamed Events)
                    \-----------------\  /----------------/
                                       v v
+-----------------------------------------------------------------------------+
|                         Response Pipeline & Storage                         |
|                                                                             |
|  1. Verify Cryptographic Signatures (Schnorr / secp256k1)                   |
|  2. Stream Matching Events Immediately to Client WebSocket                  |
|  3. Asynchronously Upsert New Events to D1 (Adhering to Replacement Rules)  |
|  4. On Upstream EOSE -> Send EOSE to Client -> Close Outbound Sockets       |
+-----------------------------------------------------------------------------+
```

---

## 3. Pull-Through Cache Lifecycle & State Machine

```
                      +-----------------------------+
                      | Client Sends ["REQ", subId] |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      | Parse & Validate NIP-01     |
                      | Filters against D1 Schema   |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      | Query Local D1 Database     |
                      +--------------+--------------+
                                     |
               +---------------------+---------------------+
               |                                           |
               v                                           v
      [Events Found in D1]                        [Check Upstream Policy]
               |                                           |
               |                                           v
               |                             +---------------------------+
               |                             | Open Outbound WebSockets  |
               |                             | to Upstream Relay Pool    |
               |                             +-------------+-------------+
               |                                           |
               |                                           v
               |                             +---------------------------+
               |                             | Send ["REQ", subId, ...]  |
               |                             | to All Active Upstreams   |
               |                             +-------------+-------------+
               |                                           |
               |                                           v
               |                             +---------------------------+
               |                             | Deduplicate Inbound       |
               |                             | Upstream Events           |
               |                             +-------------+-------------+
               |                                           |
               |                                           v
               |                             +---------------------------+
               |                             | Verify Schnorr Signature  |
               |                             | & SHA-256 Event ID Hash   |
               |                             +-------------+-------------+
               |                                           |
               v                                           v
+-------------------------------------------------------------------------+
|                  Stream ["EVENT", subId, event] to Client               |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|        Async D1 Persistence (Batch Upsert with Replacement Precedence)  |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|   Upstream Sends EOSE -> Forward ["EOSE", subId] -> Teardown Upstreams  |
+-------------------------------------------------------------------------+
```

---

## 4. NIP Compliance & Support Matrix

| NIP | Title | Relay Implementation Details | Status |
| :--- | :--- | :--- | :--- |
| **NIP-01** | Basic Protocol Flow | Full support for `EVENT`, `REQ`, `CLOSE`, `EOSE`, `NOTICE`, `OK`, and `CLOSED`. Full subscription handling and filter compilation. | **Core (v1.0)** |
| **NIP-09** | Event Deletion | Processes deletion events (Kind 5). Deletes referenced events authored by the same `pubkey` from D1 and drops future cache writes. | **Core (v1.0)** |
| **NIP-11** | Relay Information Document | HTTP GET with `Accept: application/nostr+json` returns relay metadata, supported NIPs, limitations, and operator contact. | **Core (v1.0)** |
| **NIP-16** | Event Treatment | Differentiates regular (immutable), replaceable (0, 3, 10000-19999), and ephemeral (20000-29999) events. | **Core (v1.0)** |
| **NIP-20** | Command Results | Standardized `OK` responses for inbound `EVENT` write requests with status messages. | **Core (v1.0)** |
| **NIP-33** | Parameterized Replaceable Events | Handles kinds 30000-39999 with `#d` tag indexing and atomic replacement on `(pubkey, kind, d_tag)`. | **Core (v1.0)** |
| **NIP-45** | Counting Results | Implements `["COUNT", sub_id, {filters}]` returning `["COUNT", sub_id, {"count": n}]` from D1 indexing. | **Planned (v1.1)** |
| **NIP-50** | Search Capability | Full-text search over `content` and `tags` using SQLite FTS5 extension if enabled on D1. | **Planned (v1.2)** |

---

## 5. Event Caching & Replacement Rules

Nostr events adhere to specific cryptographic and replacement semantics. Storage in Cloudflare D1 follows strict mathematical and temporal validation:

### 1. Regular Events (Kinds 1, 2, 4–9999)
- **Semantics:** Strictly immutable.
- **Storage Strategy:** Cached indefinitely keyed by SHA-256 `id`.
- **D1 Operation:** `INSERT OR IGNORE INTO events ...`
- **Eviction:** Retained permanently unless pruned by automated retention policies or deleted via valid NIP-09 Kind 5 event.

### 2. Replaceable Events (Kinds 0, 3, 10000–19999)
- **Semantics:** Unique per `(pubkey, kind)`.
- **Precedence Rule:** An incoming event replaces an existing record if and only if:
  $$\text{new.created\_at} > \text{existing.created\_at}$$
  If timestamps are equal, the event with the lower lexicographical SHA-256 `id` is retained.
- **D1 Operation:** Atomic conditional upsert using `ON CONFLICT(pubkey, kind) DO UPDATE SET ... WHERE excluded.created_at > events.created_at`.

### 3. Parameterized Replaceable Events (Kinds 30000–39999)
- **Semantics:** Unique per `(pubkey, kind, d_tag)`. The `d_tag` is extracted from the `["d", "value"]` tag (defaulting to `""` if absent).
- **Precedence Rule:**
  $$\text{new.created\_at} > \text{existing.created\_at}$$
- **D1 Operation:** Atomic conditional upsert keyed by composite index `(pubkey, kind, d_tag)`.

### 4. Ephemeral Events (Kinds 20000–29999)
- **Semantics:** Real-time transient messages (e.g. typing indicators, ephemeral challenges).
- **Storage Strategy:** **NEVER stored in D1.** Broadcasted directly to active matching client WebSocket sessions, then discarded from memory.

---

## 6. Database Schema & Index Design (Cloudflare D1)

```sql
-- Main Events Table
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,                       -- 64-char hex SHA-256 hash
    pubkey TEXT NOT NULL,                      -- 64-char hex secp256k1 public key
    created_at INTEGER NOT NULL,               -- Unix epoch timestamp in seconds
    kind INTEGER NOT NULL,                     -- Nostr Event Kind integer
    tags TEXT NOT NULL,                        -- Canonical JSON array of tag arrays
    content TEXT NOT NULL,                     -- Raw text payload
    sig TEXT NOT NULL,                         -- 128-char hex Schnorr signature
    d_tag TEXT DEFAULT NULL,                   -- Extracted 'd' tag value for parameterized replaceable
    created_at_recorded INTEGER NOT NULL       -- Ingest timestamp for relay-side monitoring
);

-- Tag Indexing Table (for high-speed multi-tag NIP-01 filters like #e, #p, #t, #d)
CREATE TABLE IF NOT EXISTS event_tags (
    event_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,                    -- Single character tag name (e, p, t, d, a, etc.)
    tag_value TEXT NOT NULL,                   -- Value indexed
    PRIMARY KEY (event_id, tag_name, tag_value),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_events_kind_created 
    ON events (kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created 
    ON events (pubkey, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_replaceable 
    ON events (pubkey, kind, d_tag, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_created 
    ON events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_tags_lookup 
    ON event_tags (tag_name, tag_value, event_id);
```

---

## 7. Phased Implementation Roadmap

```
+-----------------------------------------------------------------------+
|  Phase 0: Project Setup, Tooling & Base Infrastructure                |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 1: Nostr Protocol Engine & Cryptographic Validation            |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 2: Cloudflare D1 Storage & NIP-01 SQL Query Compiler           |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 3: Durable Objects ClientSession & WebSocket Lifecycle         |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 4: Outbound Pull-Through Relay Pool & Proxy Engine             |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 5: NIP-11 Document & HTTP Administration Routes                |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 6: Hardening, Rate Limiting, Automated Tests & Benchmarks      |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|  Phase 7: Production Deployment & Edge DNS Routing                    |
+-----------------------------------------------------------------------+
```

### Phase 0: Project Setup, Tooling & Base Infrastructure
- [x] Initialize repository structure with strict `.nvmrc` (Node 20+ LTS).
- [x] Configure `package.json` with `@cloudflare/workers-types`, `@noble/curves`, `@noble/hashes`, and `typescript`.
- [x] Configure `wrangler.jsonc` with D1 database bindings, Durable Object bindings, and `nodejs_compat`.
- [x] Build production `Makefile` with standard developer commands (`make dev`, `make build`, `make test`, `make deploy`, `make db-migrate`).

### Phase 1: Nostr Protocol Engine & Cryptographic Validation
- [x] Implement TypeScript interfaces for all Nostr NIP-01 message schemas (`EVENT`, `REQ`, `CLOSE`, `EOSE`, `OK`, `NOTICE`).
- [x] Implement canonical NIP-01 event JSON serializer:
  $$\text{serialize}(e) = \text{JSON.stringify}([0, e.pubkey, e.created\_at, e.kind, e.tags, e.content])$$
- [x] Implement SHA-256 event ID verification.
- [x] Implement BIP-340 Schnorr signature verification over secp256k1 using `@noble/curves/secp256k1`.
- [x] Unit test crypto validator against official Nostr test vectors.

### Phase 2: Cloudflare D1 Storage & NIP-01 SQL Query Compiler
- [x] Author migration `migrations/0001_initial_schema.sql` for tables `events` and `event_tags`.
- [x] Implement query builder translating complex NIP-01 filters (`ids`, `authors`, `kinds`, `#e`, `#p`, `#d`, `since`, `until`, `limit`) into parameterized SQLite queries.
- [x] Implement transaction-safe D1 upsert helper with conditional replacement logic for kinds 0, 3, 10000+, and 30000+.
- [x] Implement NIP-09 deletion query execution.

### Phase 3: Durable Objects ClientSession & WebSocket Lifecycle
- [x] Implement `ClientSession` Durable Object class using Cloudflare WebSocket Hibernation API.
- [x] Maintain in-memory subscription registry (`Map<string, NostrFilter[]>`).
- [x] Implement subscription deduplication tracker to avoid resending duplicate events to client.
- [x] Handle client disconnection, socket error cleanup, and subscription termination (`CLOSE`).


### Phase 4: Outbound Pull-Through Relay Pool & Proxy Engine
- [x] Implement ephemeral upstream WebSocket pool manager connecting to configured upstream relays (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`).
- [x] Dispatch parallel `REQ` messages to upstreams on cache misses.
- [x] Stream incoming verified events to the client WebSocket in real-time.
- [x] Collect incoming events and queue them for batch writing to D1.
- [x] Coordinate upstream `EOSE` signals: emit `EOSE` to client and gracefully terminate upstream sockets.

### Phase 5: NIP-11 Document & HTTP Administration Routes
- [x] Implement Worker fetch handler for HTTP GET requests.
- [x] Detect `Accept: application/nostr+json` header and return valid NIP-11 JSON relay document for `cache.nostr.org.tr`.
- [x] Implement `/health` endpoint reporting D1 connectivity, memory state, and active sessions.
- [x] Implement CORS headers for all HTTP endpoints.

### Phase 6: Hardening, Rate Limiting, Automated Tests & Benchmarks
- [x] Implement IP and pubkey-based rate limiting on WebSocket connections.
- [x] Implement payload size limits (e.g. max event size 64KB, max filters per subscription 10).
- [x] Build automated test suite in Vitest:
  - Protocol message serialization/deserialization.
  - Signature verification edge cases.
  - Filter-to-SQL compiler integration tests.
  - Event replacement precedence tests.
- [x] Execute load tests simulating concurrent WebSocket client subscriptions.

### Phase 7: Production Deployment & Edge DNS Routing
- [x] Create remote D1 database on Cloudflare account (`nostr_cache_db` / `6009d0a9-1d83-4c6b-a741-f6f4326e8102`).
- [x] Configure SQLite-backed Durable Object migration (`new_sqlite_classes: ["ClientSession"]`) to support modern Cloudflare accounts.
- [x] Configure custom domain routing in `wrangler.jsonc` for `cache.nostr.org.tr`.
- [x] Configure production operational targets in `Makefile` (`db-create`, `db-migrate-remote`, `deploy`, `tail`, `verify-live`).
- [x] Build automated live deployment and latency verification suite (`scripts/verify-relay.ts`).
- [x] Author comprehensive production operations and deployment runbook (`DEPLOYMENT.md`).
- [ ] Run remote D1 database migrations (`make db-migrate-remote`).
- [ ] Deploy Cloudflare Worker & Durable Objects via `make deploy`.
- [ ] Verify edge latency and live client subscriptions using `make verify-live` and standard Nostr clients (`nak`, Coracle, Primal, Amethyst).

---

## 8. Resilience, Edge Cases & Failure Modes

| Failure Scenario | Mitigation Strategy |
| :--- | :--- |
| **Upstream Relay Timeout / Hang** | Set strict timeout (e.g., 5 seconds) on upstream socket responses. If upstream fails to emit `EOSE`, synthesize `EOSE` to unblock client. |
| **Upstream Connection Refusal / Drop** | Gracefully degrade by serving local D1 cached events and logging upstream health. |
| **Malformed / Invalid Event from Upstream** | Cryptographically reject invalid events before forwarding or caching. Log error notice. |
| **D1 Concurrent Write Contention** | Buffer write operations in Durable Object memory and execute batch inserts (`db.batch(...)`) asynchronously. |
| **Large Response Flooding** | Enforce a hard default `limit` (max 500 events) on unbounded client filter queries. |
| **Ephemeral Event Leakage** | Explicit check in storage pipeline: discard kind in range `[20000, 29999]` prior to D1 insertion. |
