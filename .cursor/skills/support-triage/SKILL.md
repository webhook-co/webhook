---
name: support-triage
description: Triage technical issues and bug reports into reproducible, actionable findings. Use when investigating a reported failure in ingestion, delivery, signing, replay, or a surface (CLI/API/web/MCP).
---

# Support triage

Turn a vague technical report into a precise, reproducible, routable finding. Technical triage only.

## Triage flow

1. **Restate the problem** in one line: which surface (CLI/API/web/MCP), which capability (receive /
   inspect / replay / deliver), and the observed vs expected behavior.
2. **Reproduce** with the smallest case: endpoint setup, a sample (redacted) event, the exact
   command/request. Note environment and version.
3. **Localize** using OpenTelemetry traces and logs — follow the event id through ingest → DO →
   delivery. Check dedup/idempotency, retry/backoff state, and signature verification.
4. **Classify:** bug vs misuse vs expected behavior; severity (data-loss/security > delivery
   failure > cosmetic); and the owning area (engine, a surface, infra, docs).
5. **Write the finding:** summary, repro steps, expected vs actual, evidence (trace/log refs),
   suspected cause, and a suggested owner. Add a regression-test idea for any real bug.

## Handling data safely

- **Redact PII/PHI** before quoting payloads/logs in any report. Never paste secrets, tokens, or
  full bodies.
- Reference events by **id**, not by contents.

## Guardrails

- Stay technical and public-safe: no customer identities, no pricing/billing internals, no business
  strategy in write-ups.
- If the issue looks like a security problem (authz bypass, SSRF, secret/PII leak), escalate to a
  security review rather than patching ad hoc.

## Progressive disclosure

Keep deep-dive playbooks (delivery-failure decision tree, signature-mismatch checklist) in
`references/`.
