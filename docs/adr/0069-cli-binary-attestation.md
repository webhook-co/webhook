# ADR 0069 — sigstore + SLSA build provenance for the binaries (distribution DIST-7)

- status: accepted (distribution Phase 3 — supply-chain provenance for the binaries).
- date: 2026-06-24
- scope: `.github/workflows/release-cli.yml` (an attestation step + `attestations: write`); a "Verifying"
  section in `packages/cli/README.md`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-7). ADR-0064/0065 (the release + binaries this
  attests), ADR-0066 (npm provenance — the same supply-chain bar for the npm package).
- review severity: medium (release supply-chain). `/code-review` + `/security-review` (infra lens).

## context

The released binaries ship with a `checksums.txt` (integrity) but no proof of *where they came from*. DIST-7
adds **sigstore-signed SLSA build provenance** so anyone can verify a binary was built by **this repo's
GitHub Actions** (not hand-uploaded or tampered) — the same supply-chain guarantee the npm package already
has via npm provenance (ADR-0066). All free (GitHub OIDC + the public sigstore/Rekor transparency log).

## decision

1. **Attest via `actions/attest-build-provenance` (GitHub-owned, allowed).** The org restricts Actions to
   GitHub-owned/verified publishers (`github_owned_allowed: true`), and this action is under `actions/` — so
   it's allowed (unlike the 3rd-party `slsa-github-generator`, which is not). One step gives **both** a
   sigstore signature (Fulcio cert + Rekor log entry) **and** SLSA build provenance. SHA-pinned
   (`@a2bbfa25…` = v4.1.0), matching the repo's `actions/checkout` convention.

2. **One step covers all binaries via `subject-checksums`.** The step reads `packages/cli/out/checksums.txt`
   (sha256sum format) and attests each listed binary's digest — no per-asset loop. Needs `attestations: write`
   + `id-token: write` (added).

3. **Verify out-of-band with `gh attestation verify`.** The attestation is stored on GitHub (not a release
   asset); `gh attestation verify wbhk-<os>-<arch> --repo webhook-co/webhook` checks it. Documented in the
   README alongside `npm audit signatures` (npm provenance) and the checksum. Provenance proves origin;
   verification by digest, so the asset name is immaterial.

4. **Real tags only.** Gated to `github.event_name == 'push'` — a `workflow_dispatch` test build shouldn't
   mint provenance for a throwaway artifact in the public transparency log.

## consequences

- Every tagged release's binaries get tamper-evident, origin-proving provenance for free; `wbhk` matches the
  npm package's supply-chain bar end to end.
- **Applies to the NEXT release.** `cli-v0.1.0` was published before this lands (and its npm version can't be
  re-published), so it carries checksums + npm provenance but not the binary attestation; `0.1.1+` will.
- **`wbhk upgrade` still gates on the checksum, not the attestation — deferred (documented).** In-CLI sigstore
  verification would need either bundling a verifier (heavy) or shelling out to `gh`/`cosign` (not guaranteed
  installed). The checksum is the practical in-process integrity gate; the attestation is for out-of-band /
  auditor verification. A best-effort "verify the attestation if `gh`/`cosign` is on PATH" is a future add.

## alternatives considered

- **`slsa-framework/slsa-github-generator`.** Rejected — 3rd-party action, blocked by the org policy;
  `actions/attest-build-provenance` gives equivalent SLSA provenance and is GitHub-owned.
- **`cosign sign-blob`, cosign installed directly (action-free).** A valid alternative that also avoids any
  marketplace-action question, but it produces a bare signature (no SLSA provenance) and ships extra
  `.sig`/`.pem` release assets + a non-`gh` verify flow. Deferred — add later if non-`gh` cosign verification
  is wanted; the GitHub-native attestation is the cleaner default.
- **Per-asset `subject-path` loop.** Rejected — `subject-checksums` attests all five from the one checksums
  file in a single step.
