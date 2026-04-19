<!-- Authored-by: Anand Palanisamy - anand@xeni.com -->

# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

This server handles on-chain HBAR transfers and refund allowances. A vulnerability could be a direct money drain — responsible disclosure matters.

### How to report

Email: **security@xeni.com**

Please include:
- **Summary** — one-sentence description of the issue.
- **Impact** — what the attacker can achieve (account takeover, unauthorized transfer, information disclosure, denial of service, etc.).
- **Reproduction steps** — minimal, reproducible. Include request/response, network conditions, env, versions of this server + upstream deps.
- **Affected version(s)** — commit SHAs or release tags.
- **Your name / handle** for acknowledgment (optional; anonymous is fine).
- **Preferred contact** for follow-up.

If the issue involves an exploit against a deployed Xeni environment (testnet-uat, mainnet-prod), say so explicitly.

### What to expect

| Step | Timeline |
|---|---|
| Acknowledgment that we received your report | Within 48 hours |
| Initial assessment (severity + triage) | Within 5 business days |
| Status updates during investigation | Weekly, or sooner on material change |
| Fix + coordinated disclosure timeline | Agreed with you based on severity |

Critical issues (active exploitation, direct money loss, key compromise) are triaged immediately. We will coordinate with you on public disclosure timing — typically 90 days or when a fix is deployed, whichever is later.

### What qualifies

In scope:
- Vulnerabilities in this server's code that could lead to unauthorized HBAR transfers, allowance misuse, audit-ledger manipulation, or account-key exposure.
- Flaws in the bootstrap scripts (`scripts/bootstrap-*.ts`) that could allow attackers to hijack treasury or topic creation.
- Vulnerabilities in how this server loads the private fee-calculator plugin (see `docs/DESIGN.md` §7).
- Dependency vulnerabilities with a clear exploit path through our code.

Out of scope:
- Issues in upstream dependencies (`hedera-agent-kit-js`, `hiero-ledger/sdk`) — please report those to their respective upstream projects. If you believe we're using an upstream feature in a risky way, that's in scope.
- Issues in the Hedera network itself.
- Social engineering, physical attacks, denial-of-service against infrastructure we don't control.
- Findings from automated scanners without a demonstrated exploit path.

### Out-of-scope channels

- Public GitHub issues: please don't — use the security email instead.
- Twitter / DMs / Slack DMs: not a reliable disclosure channel. Security email is the only tracked path.

## Safe harbor

We support good-faith security research. Researchers who follow this policy will not be pursued legally for their activities, provided:
- They make a good-faith effort to avoid privacy violations, data destruction, and service disruption.
- They give us reasonable time to fix before public disclosure.
- They don't exploit the vulnerability beyond what's necessary to demonstrate it.

## Questions

If you're unsure whether something qualifies, err on the side of emailing us. We'd rather triage a non-issue than miss a real one.
