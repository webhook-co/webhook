#!/bin/sh
# wbhk installer (DIST-5). Detects your OS/arch, downloads the matching binary from the latest GitHub
# release, verifies its sha256, and installs it.
#
#   curl -fsSL https://get.webhook.co | sh
#
# Env overrides:
#   WBHK_INSTALL_DIR=/usr/local/bin   # where to install (default: $HOME/.local/bin)
#   WBHK_VERSION=0.3.0                # pin a version (default: latest published release)
#
# POSIX sh (no bashisms). macOS + Linux only — on Windows use Scoop or grab the .exe from the releases page.
set -eu

REPO="webhook-co/webhook"
BIN="wbhk"

say() { printf '%s\n' "wbhk-install: $*"; }
err() {
  printf '%s\n' "wbhk-install: error: $*" >&2
  exit 1
}

fetch() { # <url> <dest>  — curl or wget, fail on HTTP error
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    err "need curl or wget on PATH"
  fi
}

verify_sha() { # reads "<hash>  <name>" on stdin; checks the named file in the cwd
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c -
  else
    err "need sha256sum or shasum to verify the download"
  fi
}

main() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) err "unsupported OS '$os' — on Windows use Scoop or download the .exe from https://github.com/${REPO}/releases" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) err "unsupported architecture '$arch'" ;;
  esac
  asset="${BIN}-${os}-${arch}"

  ver="${WBHK_VERSION:-}"
  if [ -n "$ver" ]; then
    base="https://github.com/${REPO}/releases/download/cli-v${ver}"
  else
    base="https://github.com/${REPO}/releases/latest/download"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "downloading ${asset} (${ver:-latest})…"
  fetch "${base}/${asset}" "${tmp}/${asset}" \
    || err "could not download ${asset} — is there a published release with a ${os}-${arch} binary?"
  fetch "${base}/checksums.txt" "${tmp}/checksums.txt" || err "could not download checksums.txt"

  # Fail CLOSED: require the asset's checksum line to EXIST before checking it. (Piping grep straight into
  # the checker is unsafe — POSIX sh has no pipefail, and some sha256sum builds [Apple's /sbin/sha256sum,
  # older GNU coreutils] exit 0 on empty stdin, so a checksums.txt that simply OMITS the asset would verify
  # nothing.) Capture the line first; a missing entry aborts.
  say "verifying checksum…"
  line="$(grep " ${asset}$" "${tmp}/checksums.txt")" \
    || err "no checksum entry for ${asset} in checksums.txt — refusing to install"
  ( cd "$tmp" && printf '%s\n' "$line" | verify_sha ) \
    || err "checksum verification FAILED — refusing to install"

  dir="${WBHK_INSTALL_DIR:-${HOME}/.local/bin}"
  mkdir -p "$dir"
  dest="${dir}/${BIN}"
  mv "${tmp}/${asset}" "$dest"
  chmod +x "$dest"
  # macOS: clear the quarantine flag so Gatekeeper doesn't block the (currently unsigned) binary.
  if [ "$os" = darwin ]; then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
  fi

  say "installed → ${dest}"
  if v="$("$dest" --version 2>/dev/null)"; then say "version: ${v}"; fi
  case ":${PATH}:" in
    *":${dir}:"*) : ;;
    *) say "note: ${dir} is not on your PATH — add:  export PATH=\"${dir}:\$PATH\"" ;;
  esac
}

main "$@"
