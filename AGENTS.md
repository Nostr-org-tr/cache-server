# Agent & Contributor Guidelines: `cache.nostr.org.tr`

> Operational instructions, engineering standards, protocol invariants, and execution workflows for AI agents and human engineers working on `cache.nostr.org.tr`.

---

## 1. Core Engineering Principles

1. **Zero Placeholder / Zero TODO Policy:**
   - Never commit `TODO`, `FIXME`, or stub functions with mocked return values in production code paths.
   - If an edge case or secondary branch exists, design and implement the complete logic immediately.
2. **Production-Grade Code Quality:**
   - Strict TypeScript (`"strict": true`, `"noImplicitAny": true`, `"exactOptionalPropertyTypes": true`).
   - Every function must have clear types, boundary checks, and explicit error handling.
3. **Security-First Architecture:**
   - Never trust input from clients or upstream relays.
   - Strictly verify SHA-256 event IDs and BIP-340 Schnorr signatures using `@noble/curves/secp256k1` before persisting to D1.
   - Zero SQL injection: all queries against Cloudflare D1 must be parameterized prepared statements.
4. **Step-by-Step, Function-by-Function Implementation:**
   - Deliver code systematically in bounded increments with automated verification.

---

## 2. Environment, Tooling & Build System

### 2.1 Node.js Version Enforcement
Always run `nvm use` prior to invoking any Node, npm, or wrangler commands. The environment requires the Node version defined in [`.nvmrc`](file:///home/delirehberi/www/cache.nostr.org.tr/.nvmrc).

```bash
nvm use
```

### 2.2 Canonical Makefile Interface
All build, development, testing, and migration commands MUST be executed via the project `Makefile`:

| Make Target | Action Performed |
| :--- | :--- |
| `make install` | Loads Node version via `nvm` and executes `npm ci` / `npm install`. |
| `make dev` | Starts local Cloudflare Worker development environment with local D1 & Durable Objects. |
| `make build` | Type-checks code and validates bundle compilation. |
| `make test` | Executes the Vitest unit and integration test suite. |
| `make lint` | Validates version sync across manifests and runs TypeScript typechecker. |
| `make version-check` | Verifies SemVer consistency between `package.json`, `package-lock.json`, and `src/version.ts`. |
| `make version-patch` | Increments patch version (e.g. 1.0.0 -> 1.0.1) and updates all files in lockstep. |
| `make version-minor` | Increments minor version (e.g. 1.0.0 -> 1.1.0) and updates all files in lockstep. |
| `make version-major` | Increments major version (e.g. 1.0.0 -> 2.0.0) and updates all files in lockstep. |
| `make version-set` | Sets an explicit version across all files (`make version-set VERSION=x.y.z`). |
| `make db-migrate-local` | Applies SQL migrations against the local D1 emulator. |
| `make db-migrate-remote` | Applies SQL migrations against the remote production Cloudflare D1 database. |
| `make deploy` | Type-checks, runs tests, and deploys Worker & Durable Objects to Cloudflare. |

---

## 3. Cryptographic & Protocol Invariants

### 3.1 Event ID Calculation (NIP-01)
The event ID must be the SHA-256 hex digest of the canonical JSON UTF-8 serialization of the following array:

$$\text{id} = \text{SHA-256}(\text{JSON.stringify}([0, \text{pubkey}, \text{created\_at}, \text{kind}, \text{tags}, \text{content}]))$$

```typescript
// Canonical serialization rule:
const serialized = JSON.stringify([
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
]);
```

### 3.2 Schnorr Signature Verification (BIP-340)
Every inbound event from a client or upstream relay must be cryptographically validated before caching:

```typescript
import { schnorr } from '@noble/curves/secp256k1';

export function verifyEventSignature(event: NostrEvent): boolean {
  const hash = computeEventId(event);
  if (hash !== event.id) {
    return false;
  }
  try {
    return schnorr.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}
```

### 3.3 Event Storage & Replacement Classification

```
+-------------------------------------------------------------------------------+
|                             Inbound Nostr Event                               |
+---------------------------------------+---------------------------------------+
                                        |
                   +--------------------+--------------------+
                   | Check Event Kind Range                  |
                   v                                         v
       [Ephemeral: 20000..29999]                   [Persistent Event]
                   |                                         |
                   v                                         v
        Stream to Active Clients                Verify Signature & ID Hash
           (DO NOT SAVE TO D1)                               |
                                           +-----------------+-----------------+
                                           |                                   |
                                           v                                   v
                             [Regular: 1, 2, 4..9999]          [Replaceable Event]
                                           |                                   |
                                           v                                   v
                                INSERT OR IGNORE INTO events        Check Kind Semantics
                                                                               |
                                                   +---------------------------+---------------------------+
                                                   |                                                       |
                                                   v                                                       v
                                      [Standard: 0, 3, 10000..19999]              [Parameterized: 30000..39999]
                                                   |                                                       |
                                                   v                                                       v
                                      Key: (pubkey, kind)                         Key: (pubkey, kind, d_tag)
                                      Precedence: new.created_at > old.created_at Precedence: new.created_at > old.created_at
```

1. **Regular Events (Kinds 1, 2, 4–9999):**
   - Insert keyed by `id`. If already exists, ignore.
2. **Replaceable Events (Kinds 0, 3, 10000–19999):**
   - Keyed on `(pubkey, kind)`.
   - Overwrite existing record **only if** `new.created_at > existing.created_at`.
   - If `new.created_at == existing.created_at`, retain the one with lowest hex `id`.
3. **Parameterized Replaceable Events (Kinds 30000–39999):**
   - Keyed on `(pubkey, kind, d_tag)`.
   - The `d_tag` is the value of the first `["d", "<val>"]` tag, or `""` if not provided.
   - Overwrite existing record **only if** `new.created_at > existing.created_at`.
4. **Ephemeral Events (Kinds 20000–29999):**
   - **MUST NEVER be inserted into D1.** Stream to active subscriptions in real-time, then discard.
5. **Deletion Events (Kind 5 - NIP-09):**
   - Delete referenced event IDs from D1 where `events.pubkey == deletion_event.pubkey`.

---

## 4. Cloudflare D1 Query & Database Guidelines

### 4.1 SQL Injection Protection & Query Parameterization
Never format SQL via raw string interpolation. Build parameterized SQL statements dynamically:

```typescript
// CORRECT:
const query = `SELECT * FROM events WHERE kind IN (${kinds.map(() => '?').join(',')}) AND created_at >= ? LIMIT ?`;
const stmt = db.prepare(query).bind(...kinds, since, limit);

// FORBIDDEN:
const query = `SELECT * FROM events WHERE kind = ${filter.kind}`; // VULNERABILITY!
```

### 4.2 Multi-Tag Filter Queries
When clients query tags (e.g. `{"#e": ["id1", "id2"], "#p": ["pubkey1"]}`), query using `event_tags` indexed joins:

```sql
SELECT e.* FROM events e
JOIN event_tags t_e ON e.id = t_e.event_id AND t_e.tag_name = 'e' AND t_e.tag_value IN (?, ?)
JOIN event_tags t_p ON e.id = t_p.event_id AND t_p.tag_name = 'p' AND t_p.tag_value IN (?)
WHERE e.kind IN (?)
ORDER BY e.created_at DESC
LIMIT ?;
```

### 4.3 Batching Upserts
When events stream in from multiple upstream relays, buffer them in the Durable Object and flush them using `db.batch([ ...statements ])` to reduce D1 round-trips and optimize transaction overhead.

---

## 5. Durable Object `ClientSession` Rules

1. **WebSocket Hibernation:** Use the Cloudflare Workers WebSocket Hibernation API (`this.ctx.acceptWebSocket(ws)`) to minimize DO memory cost and allow sleep states during idle connections.
2. **Subscription Isolation:** Each client connection can open multiple subscriptions (`sub_id`). Subscriptions must be stored in a `Map<string, NostrFilter[]>` keyed by `sub_id`.
3. **Upstream Lifecycle Management:**
   - Outbound WebSocket connections to upstreams (`relay.damus.io`, `nos.lol`, etc.) are temporary and spawned on-demand when client requests require upstream pull-through.
   - Once all active upstreams emit `EOSE`, or upon reaching a 5-second timeout, send `["EOSE", sub_id]` to the client and close outbound sockets to free resources.
   - Client WebSocket connection stays open for subsequent requests.

---

## 6. Testing & Quality Assurance Standards

1. **Unit Testing:**
   - Every protocol serializer, validator, crypto helper, and query builder must have corresponding tests in `tests/`.
   - Run tests with `make test` (Vitest).
2. **Edge Cases to Test:**
   - Event with signature tampering (must fail verification).
   - Event with mismatched ID (must fail verification).
   - Parameterized replaceable event with missing `d` tag (must default `d_tag` to `""`).
   - Replaceable event with older `created_at` timestamp (must be dropped).
   - SQL query compiler with empty filter objects and edge filters (empty arrays, negative limits).
3. **Lint & Type Check:**
   - `make lint` must pass with zero warnings or errors.

---

## 7. Operational Checklist for Future Development

When implementing any future module:
- [ ] Verify node environment: `nvm use`
- [ ] Check NIP standard documentation for subtleties.
- [ ] Ensure all D1 queries use index-backed paths.
- [ ] Run `make test` and `make lint`.
- [ ] Run security audit check on new code (signature validation, input bounds, memory limits).
