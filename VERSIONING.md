# Semantic Versioning & Automated Release Strategy

> Canonical guide for semantic versioning, automated synchronization, and release lifecycles in `cache.nostr.org.tr`.

---

## 1. Overview & Single Source of Truth

`cache.nostr.org.tr` strictly adheres to **Semantic Versioning 2.0.0** (`MAJOR.MINOR.PATCH` with optional pre-release identifiers like `-beta.0` or `-rc.1`).

To prevent version drift between package declarations, build manifests, and runtime protocol responses:
- **`src/version.ts`** acts as the compiled TypeScript source of truth exporting `APP_VERSION` and relay identity constants.
- **`package.json`** and **`package-lock.json`** are kept in strict lockstep.
- Runtime handlers (NIP-11 Document at `/`, `/health`, and `/stats`) import `APP_VERSION` directly, guaranteeing zero hardcoded version strings.

```
+-----------------------------------------------------------------------------+
|                             Versioning System                               |
+-----------------------------------------------------------------------------+
                                       |
                       +---------------+---------------+
                       |                               |
                       v                               v
         [Release / Version Command]          [Continuous Integration]
          `make version-patch`                 `make version-check`
          `make version-minor`                 `make lint` / `make test`
          `make version-major`                         |
          `make version-set VERSION=x.y.z`             |
                       |                               |
                       v                               v
            [scripts/bump-version.ts]       [scripts/check-version-sync.ts]
                       |                               |
                       +---------------+---------------+
                                       |
                   +-------------------+-------------------+
                   | Updates & Synchronizes in Lockstep    |
                   v                                       v
         [package.json & lockfile]                 [src/version.ts]
         { "version": "1.0.1" }                    export const APP_VERSION = '1.0.1';
                                                           |
                                       +-------------------+-------------------+
                                       | Imports APP_VERSION                   |
                                       v                   v                   v
                               [src/http/nip11.ts] [src/http/health.ts] [src/http/stats.ts]
```

---

## 2. Versioning Semantics

Given a version number `MAJOR.MINOR.PATCH`:

1. **MAJOR (`X.0.0`):** Incompatible API changes, protocol-breaking changes, or breaking schema migrations.
2. **MINOR (`0.X.0`):** Backwards-compatible new features, new NIP implementations, new query filter optimizations, or telemetry additions.
3. **PATCH (`0.0.X`):** Backwards-compatible bug fixes, performance improvements, upstream handling tweaks, or security patches.
4. **Pre-release (`X.Y.Z-beta.N`, `X.Y.Z-rc.N`):** Staging candidates or beta releases.

---

## 3. Automated Version Management Commands

All version updates should be executed via the `Makefile` or npm scripts:

| Command | Action | Example |
| :--- | :--- | :--- |
| `make version-check` | Verifies version consistency across `package.json`, `package-lock.json`, and `src/version.ts`. | `make version-check` |
| `make version-patch` | Increments PATCH version (e.g., `1.0.0` -> `1.0.1`) and updates all files in lockstep. | `make version-patch` |
| `make version-minor` | Increments MINOR version (e.g., `1.0.0` -> `1.1.0`) and updates all files in lockstep. | `make version-minor` |
| `make version-major` | Increments MAJOR version (e.g., `1.0.0` -> `2.0.0`) and updates all files in lockstep. | `make version-major` |
| `make version-set VERSION=x.y.z` | Sets an explicit version across all files. | `make version-set VERSION=1.2.0-rc.1` |

### Command-Line Arguments & Flags

You can also use `scripts/bump-version.ts` directly:
```bash
# Dry run check
npm run version:bump -- --dry-run patch

# Prerelease bump with custom preid
npm run version:bump -- prepatch --preid=rc
```

---

## 4. Continuous Integration & Quality Gates

The version integrity check is integrated into `make lint` and the automated test suite:

- **Lint Gate:** `npm run lint` / `make lint` executes `scripts/check-version-sync.ts` before running `tsc --noEmit`.
- **Unit Testing:** `tests/version.test.ts` asserts SemVer validity, file sync, and runtime endpoint payload correctness.
