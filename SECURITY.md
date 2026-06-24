# Security Policy

`@lucascouts/claude-agent-tui` is the published npm mirror of the Claude Code
ACP bridge. This document describes the supply-chain controls on the published
artifact and how to report a vulnerability.

## Reporting a Vulnerability

Report privately to the maintainer (`otakugeekx@gmail.com`) or via GitHub
**Private vulnerability reporting** (Security tab → _Report a vulnerability_).
Please do not open a public issue for a security report. Include affected
version, reproduction, and impact. Expect an initial acknowledgement within a
few days.

## Supply-Chain & Security Controls

Controls are **warn-first**: scanners run in CI but do **not** block the
pipeline. Promoting any scanner to _blocking_ is a later, explicit decision.

### Active (wired)

| Area              | Control                                                               | Detail                                                   |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Secret scanning   | **gitleaks**                                                          | pre-commit hook + CI job                                 |
| Secret scanning   | **trufflehog**                                                        | CI job, `fetch-depth: 0` (diff base..head)               |
| SCA (known CVEs)  | **OSV-Scanner**                                                       | warn-first CI job over `package-lock.json`               |
| SAST              | **CodeQL default setup**                                              | JS/TS + Python + Actions on `main`                       |
| Provenance        | **npm trusted publishing** (OIDC) + `--provenance`                    | no long-lived `NPM_TOKEN`; signed provenance attestation |
| Release integrity | **Syft SBOM** (SPDX-JSON) of the release tarball                      | attached as a release asset                              |
| Release integrity | **Cosign keyless signing** (Fulcio/Rekor, OIDC) of the tarball + SBOM | `.sig`/`.pem` attached as release assets                 |
| Supply chain      | every third-party Action **pinned by commit SHA**                     | all workflows                                            |
| Supply chain      | **dependabot** with a **7-day cooldown** on both ecosystems           | `dependabot.yml`                                         |
| Frozen installs   | `npm ci` everywhere (committed lockfile)                              | —                                                        |

### Verifying a release

Each release attaches the deterministic bundle `claude-agent-tui-<ver>.tar.gz`,
its SBOM `*.sbom.spdx.json`, and Cosign signatures (`*.sig` + `*.pem`). Verify
the tarball signature with:

```sh
cosign verify-blob \
  --certificate claude-agent-tui-<ver>.tar.gz.pem \
  --signature   claude-agent-tui-<ver>.tar.gz.sig \
  --certificate-identity-regexp 'https://github.com/lucascouts/claude-agent-tui/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  claude-agent-tui-<ver>.tar.gz
```

The npm package itself carries signed **provenance** — inspect it with
`npm audit signatures` after install.

### Recommended (not wired) — Socket

[Socket](https://socket.dev) provides behavioral / zero-day supply-chain
detection — **especially relevant** here given the native `node-pty`
post-install build and the pre-1.0 Anthropic/ACP SDKs. It is **not wired** as a
CI gate because PR-time gating requires installing a **GitHub App** on the
account (suggest-first policy). This package is **already publicly indexed** —
review its score/flags at
<https://socket.dev/npm/package/@lucascouts/claude-agent-tui>. Installing the
App is the opt-in upgrade for PR-time gating.

## Notes

- The external `claude` CLI binary is out of npm scope; its drift is tracked by
  an offline detector in the source repo (story 049).
- Enforcement level (warn vs block) for every scanner is reviewed at PR time.
