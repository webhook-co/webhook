# ee/ — license-fenced (proprietary)

Everything under `ee/` is **proprietary** and is **not** covered by the repository's Apache-2.0
license. Self-host builds exclude this directory entirely.

Boundary rules (enforced by convention and review):

- Open-core code (`apps/*`, `packages/*`) **must not** import from `ee/`.
- `ee/` code may depend on open-core packages, never the reverse.

See `AGENTS.md` → "Open-core boundary" for the durable principle. A commercial `LICENSE` will be
added here before any proprietary code lands.
