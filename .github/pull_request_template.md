## Description

Please provide a concise explanation of the changes introduced in this pull request and the problem they solve.

---

## Type of Change

- [ ] `feat`: A new feature or protocol implementation (e.g. NIP support)
- [ ] `fix`: A bug fix
- [ ] `perf`: A performance optimization or latency improvement
- [ ] `refactor`: Code change that neither fixes a bug nor adds a feature
- [ ] `docs`: Documentation updates or additions
- [ ] `test`: Adding missing tests or correcting existing tests
- [ ] `ci`: Changes to CI/CD workflows or build configurations

---

## Related Issue / Context

Closes # (issue number if applicable)

---

## Verification & Quality Checklist

Please confirm that your changes meet the following quality gates:

- [ ] All unit and integration tests pass cleanly (`make test`).
- [ ] TypeScript strict typechecking and SemVer validation pass (`make lint`).
- [ ] Project bundle builds with zero errors (`make build`).
- [ ] Zero `TODO` or `FIXME` placeholders in production code.
- [ ] Inbound Nostr events strictly verify BIP-340 Schnorr signatures and SHA-256 event IDs.
- [ ] All D1 database queries use parameterized prepared statements (no string interpolation).
- [ ] Documentation (`README.md`, `DEPLOYMENT.md`, or `ROADMAP.md`) updated if applicable.
