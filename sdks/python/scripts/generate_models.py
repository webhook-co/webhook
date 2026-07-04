#!/usr/bin/env python3
"""Generate the SDK's pydantic v2 models from the golden OpenAPI document.

The models are DERIVED from packages/openapi/src/openapi.json (itself drift-guarded against the Zod
contract), so the SDK can never silently diverge from the wire shape. The output is committed and
drift-tested (tests/test_generated_drift.py) exactly like the golden spec, using PINNED tool versions
(see pyproject.toml [project.optional-dependencies].dev) so the bytes are reproducible in CI.

Pipeline: run datamodel-code-generator, then collapse the scalar RootModel wrappers it emits for
`anyOf: [constrained-scalar, null]` fields (so `delivery.status_code == 200` works instead of silently
being False), then re-format with black. `render()` is the single source of truth used by both `main()`
and the drift test, so the committed bytes are exactly reproducible.

Regenerate:  python -m scripts.generate_models   (from sdks/python, with the dev extras installed)
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile

import black

HERE = pathlib.Path(__file__).resolve().parent
PACKAGE_ROOT = HERE.parent
SPEC = PACKAGE_ROOT.parent.parent / "packages" / "openapi" / "src" / "openapi.json"
OUT = PACKAGE_ROOT / "src" / "webhook_co" / "_generated" / "models.py"

# Flags chosen for a modern, stable pydantic v2 surface: PEP 604 unions (`X | None`), builtin generics
# (`list`/`dict`), and `Annotated` field constraints, snake_case attributes with camelCase aliases,
# `format: uuid` as plain str, forward-compatible `extra=ignore`, and OPEN enums (so an older SDK doesn't
# crash on a new server-side enum value). Keep this list in lockstep with the drift test via `render()`.
ARGS = [
    "--input-file-type",
    "openapi",
    "--output-model-type",
    "pydantic_v2.BaseModel",
    "--target-python-version",
    "3.10",
    "--use-annotated",
    "--use-standard-collections",
    "--use-union-operator",
    "--use-schema-description",
    "--snake-case-field",
    "--type-mappings",
    "uuid=string",
    "--ignore-enum-constraints",
    "--extra-fields",
    "ignore",
    "--formatters",
    "black",
    "isort",
    "--disable-timestamp",
]

# The pinned black target — matches the SDK's minimum Python and keeps the collapse re-format reproducible.
_BLACK_MODE = black.Mode(target_versions={black.TargetVersion.PY310})

_SIMPLE_BASES = {"int", "str", "float", "bool"}
_ROOT_HEADER = re.compile(r"^class (\w+)\(RootModel\[(\w+)\]\):$")


def build_argv(input_path: pathlib.Path, output_path: pathlib.Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "datamodel_code_generator",
        "--input",
        str(input_path),
        "--output",
        str(output_path),
        *ARGS,
    ]


def _collapse_scalar_root_models(text: str) -> str:
    """Inline `class X(RootModel[<scalar>])` wrappers to their base scalar.

    datamodel-code-generator wraps a constrained scalar inside an `anyOf: [scalar, null]` in a named
    RootModel (e.g. `StatusCode(RootModel[int])`), typing the field as `StatusCode | None`. That reads
    wrong (`delivery.status_code == 200` is always False; `str(destination_id)` is `"root=..."`). Only
    the SCALAR RootModels are collapsed; a union RootModel (e.g. `AuditVerifyResponse`) is left intact.
    """
    lines = text.split("\n")
    kept: list[str] = []
    mapping: dict[str, str] = {}
    i = 0
    while i < len(lines):
        header = _ROOT_HEADER.match(lines[i])
        if header and header.group(2) in _SIMPLE_BASES:
            mapping[header.group(1)] = header.group(2)
            # Drop the class block: its header + all following blank/indented body lines.
            i += 1
            while i < len(lines) and (
                lines[i] == "" or lines[i].startswith((" ", "\t"))
            ):
                i += 1
            continue
        kept.append(lines[i])
        i += 1
    result = "\n".join(kept)
    for name, base in mapping.items():
        result = re.sub(rf"\b{name}\b", base, result)
    return result


def render(spec_path: pathlib.Path) -> str:
    """The full generation pipeline (datamodel-codegen → collapse scalar RootModels → black). The single
    source of truth for the committed file and the drift test.
    """
    with tempfile.TemporaryDirectory() as tmp:
        raw_out = pathlib.Path(tmp) / "models.py"
        subprocess.run(build_argv(spec_path, raw_out), check=True, capture_output=True)
        raw = raw_out.read_text()
    collapsed = _collapse_scalar_root_models(raw)
    return black.format_str(collapsed, mode=_BLACK_MODE)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(SPEC))
    print(f"✓ generated {OUT}")


if __name__ == "__main__":
    main()
