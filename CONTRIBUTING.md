# Contributing to `cache.nostr.org.tr`

Thank you for your interest in contributing to the Nostr Turkey regional cache relay! We welcome contributions from open-source developers, protocol researchers, and operators.

---

## 1. Code of Conduct

All contributors and maintainers are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before participating.

---

## 2. Getting Started & Development Setup

### 2.1 Prerequisites
- **Node.js LTS (>= v20.0.0)** managed via [`.nvmrc`](.nvmrc).
- **npm** (bundled with Node.js).
- **Wrangler CLI** (installed as a devDependency).

### 2.2 Setup Instructions
```bash
# Clone repository
git clone https://github.com/Nostr-org-tr/cache-server.git
cd cache-server

# Load Node version via nvm and install dependencies
make install

# Apply local D1 SQLite database migrations
make db-migrate-local

# Start the local development edge worker
make dev
```

---

## 3. Engineering & Quality Standards

When contributing code, please uphold the engineering standards defined in [AGENTS.md](AGENTS.md):

1. **Zero Placeholder / Zero TODO Policy:**
   - Never commit `TODO`, `FIXME`, or stub functions in production paths. Write the complete, production-ready implementation immediately.
2. **Strict TypeScript:**
   - `"strict": true`, `"noImplicitAny": true`, `"exactOptionalPropertyTypes": true`.
3. **Cryptographic Validation:**
   - All inbound events must strictly verify SHA-256 event IDs and BIP-340 Schnorr signatures using `@noble/curves/secp256k1`.
4. **SQL Injection Prevention:**
   - Never format SQL via string interpolation. Use parameterized prepared statements against Cloudflare D1.
5. **Durable Objects & Hibernation:**
   - WebSocket sessions must utilize Cloudflare Workers WebSocket Hibernation APIs (`this.ctx.acceptWebSocket(ws)`).

---

## 4. Makefile Interface & Verification Commands

All linting, testing, and building must be performed through the `Makefile`:

| Command | Action |
| :--- | :--- |
| `make install` | Loads Node via `nvm` and installs npm dependencies. |
| `make dev` | Starts local Cloudflare Worker environment with local D1 & Durable Objects. |
| `make lint` | Validates SemVer synchronization and runs TypeScript strict typechecking. |
| `make test` | Runs the full Vitest unit and integration test suite. |
| `make bench` | Executes micro-benchmarks and concurrent load simulation tests. |
| `make build` | Verifies bundle compilation and type safety. |
| `make all` | Executes `lint`, `test`, and `build` in sequence. |

Before submitting any Pull Request, verify that all checks pass cleanly:
```bash
make all
```

---

## 5. Branching & Commit Guidelines

- **Branch Naming:**
  - `feat/feature-name` for new features or NIP protocol additions.
  - `fix/bug-name` for bug fixes.
  - `perf/optimization-name` for performance improvements.
  - `docs/doc-update` for documentation changes.
- **Commit Messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat(upstream): add nip65 relay fallback strategy`
  - `fix(db): correct replaceable event tie-breaker on equal timestamps`
  - `test(crypto): add edge-case tests for invalid signature sizes`
  - `docs: update NIP support matrix in README`

---

## 6. Pull Request Submission Checklist

When opening a Pull Request:
- [ ] Ensure all unit and integration tests pass (`make test`).
- [ ] Ensure code compiles and type checks with zero errors (`make lint`).
- [ ] Include tests for new functionality, bug fixes, or edge cases.
- [ ] Do not leave `TODO` comments or mock return values in production code.
- [ ] Update documentation (`README.md`, `ROADMAP.md`, `DEPLOYMENT.md`) if architecture or configuration changes.
