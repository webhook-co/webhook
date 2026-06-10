# Security policy

We take the security of `webhook` seriously — it's webhook infrastructure built
compliance-by-design, so trust is the product.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **[Security Advisories](https://github.com/webhook-co/webhook/security/advisories/new)**
("Report a vulnerability"). If that's unavailable to you, email **security@webhook.co** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected versions/components, and
- any suggested remediation.

Please give us a reasonable window to investigate and ship a fix before any public disclosure. We
aim to acknowledge reports within a few business days and will keep you updated on progress. We're
grateful for responsible disclosure and will credit reporters who want it.

## Scope

This repository is the open core (Apache-2.0). Issues in dependencies should generally be reported
upstream, but tell us if a dependency issue affects `webhook` directly — Dependabot and CI secret
scanning help us stay ahead of these.

## Handling secrets

Never commit secrets, keys, tokens, or credentials. Multiple layers guard this:

- GitHub-native **secret scanning + push protection**,
- a **gitleaks** CI check, and
- local pre-commit hooks.

If you believe a secret was committed, treat it as compromised: **rotate it immediately** and
report it through the channel above.
