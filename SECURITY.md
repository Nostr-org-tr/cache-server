# Security Policy

## Supported Versions

Security updates and critical patches are actively provided for the latest minor and patch releases on the `master` branch.

| Version | Supported          |
| :---    | :---:              |
| 1.2.x   | :white_check_mark: |
| < 1.2.0 | :x:                |

---

## Reporting a Vulnerability

The maintainers of `cache.nostr.org.tr` take protocol and edge application security seriously. If you discover a security vulnerability, we appreciate your effort in responsibly disclosing it to us privately.

### Private Reporting Channels

1. **Email (Preferred):** Send details of the vulnerability to [admin@nostr.org.tr](mailto:admin@nostr.org.tr) with the subject `[SECURITY] cache.nostr.org.tr Vulnerability Report`.
2. **GitHub Security Advisory:** Submit a private advisory report directly via [GitHub Security Advisories](https://github.com/Nostr-org-tr/cache-server/security/advisories/new).

Please **do not** open public issues or pull requests for security vulnerabilities until they have been coordinated and resolved.

---

## What to Include in Your Report

To help us triage and resolve the issue quickly, please provide:

- A description of the vulnerability and its potential impact.
- Detailed step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
- Any affected endpoints, NIP protocol handlers, D1 SQL queries, or Durable Object classes.
- Your suggested mitigation or patch, if available.

---

## Response & Disclosure Process

- **Initial Acknowledgment:** Within **48 hours**, we will acknowledge receipt of your report.
- **Triage & Assessment:** We will investigate and confirm the severity and scope within **5 business days**.
- **Fix & Patch Deployment:** A patch will be developed, tested against the test suite, and deployed to production.
- **Public Disclosure:** Once deployed and verified, a public advisory and changelog will be published crediting the reporter (unless you prefer anonymity).
