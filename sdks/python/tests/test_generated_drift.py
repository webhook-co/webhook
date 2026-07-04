"""Drift guard for the generated pydantic models.

The committed ``_generated/models.py`` MUST equal a fresh render of the golden OpenAPI document — so a
spec change that isn't regenerated (``python -m scripts.generate_models``) fails CI instead of shipping an
SDK whose models silently disagree with the wire contract. Reproducibility relies on the PINNED tool
versions in pyproject.toml (datamodel-code-generator + black + isort).
"""

from __future__ import annotations

from scripts.generate_models import OUT, SPEC, render


def test_generated_models_in_sync_with_spec():
    assert (
        render(SPEC) == OUT.read_text()
    ), "generated models are stale — run `python -m scripts.generate_models`"
