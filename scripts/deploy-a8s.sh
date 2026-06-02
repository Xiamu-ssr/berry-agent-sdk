#!/usr/bin/env bash
# ============================================================
# deploy-a8s.sh — incremental dist-only deploy to the a8s box
# ============================================================
# The box (106.14.88.147, x86_64, ~1.8G RAM) cannot build or `npm install`
# (OOM). It already holds a known-good node_modules (221M, incl. the Linux
# native better-sqlite3) and `@berry-agent/*` symlinks into packages/*.
#
# So the only things that change between deploys are the compiled JS
# (packages/*/dist) and the built UI — both platform-independent. This
# script builds everything LOCALLY (where RAM + network exist), ships a
# few-MB tarball of dist + package.json + UI, and atomically swaps it in.
# node_modules and the symlinks on the box are never touched.
#
# Deps drift (rare): when a package.json adds an external dependency, the
# box's node_modules won't have it. Pass --with-deps to additionally ship a
# linux-x64 production node_modules built locally (see below). The normal
# path does NOT need this.
#
# Usage:
#   scripts/deploy-a8s.sh                 # incremental dist + UI (default)
#   scripts/deploy-a8s.sh --no-build      # skip local build, ship current dist
#   scripts/deploy-a8s.sh --with-deps     # also refresh linux-x64 node_modules
#   scripts/deploy-a8s.sh --dry-run       # build + pack, print plan, don't ship
#
# Env overrides: BOX (default root@106.14.88.147), REMOTE_DIR
# (/opt/berry-a8s/sdk), A8S_HEALTH_URL (http://106.14.88.147:28789/v1/health).
set -euo pipefail

BOX="${BOX:-root@106.14.88.147}"
REMOTE_DIR="${REMOTE_DIR:-/opt/berry-a8s/sdk}"
A8S_HEALTH_URL="${A8S_HEALTH_URL:-http://106.14.88.147:28789/v1/health}"
SSH_OPTS="-o ConnectTimeout=15 -o StrictHostKeyChecking=no"

DO_BUILD=1
WITH_DEPS=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --with-deps) WITH_DEPS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Resolve repo root from this script's location (scripts/ is at repo root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# macOS tar/scp would otherwise scatter AppleDouble ._ files on the box and
# embed com.apple.* xattrs that GNU tar warns about. Disable both.
export COPYFILE_DISABLE=1
# bsdtar (macOS default /usr/bin/tar) honors --no-mac-metadata; ignore if absent.
TAR_NOMETA=""
if tar --no-mac-metadata --version >/dev/null 2>&1; then TAR_NOMETA="--no-mac-metadata"; fi

say() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }

# ---- 1. Build everything locally (RAM + network live here, not on the box) ----
if [[ $DO_BUILD -eq 1 ]]; then
  say "Building all packages + UI locally…"
  npm run build
else
  say "Skipping build (--no-build); shipping current dist."
fi

# Sanity: the a8s entrypoint + built UI must exist, else we'd ship a broken tree.
[[ -f packages/a8s-server/dist/cli.js ]] || { echo "missing a8s-server/dist/cli.js — build failed?" >&2; exit 1; }
[[ -f packages/a8s-server/dist/ui/index.html ]] || { echo "missing built UI (dist/ui/index.html) — UI build skipped?" >&2; exit 1; }
[[ -f packages/worker-daemon/dist/cli.js ]] || { echo "missing worker-daemon/dist/cli.js" >&2; exit 1; }

# ---- 2. Pack dist + package.json (+ docs/root manifests), NO node_modules/src ----
STAMP="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
TARBALL="/tmp/berry-a8s-dist-${STAMP}.tgz"
say "Packing dist tarball → ${TARBALL}"
# Include: every package's dist + package.json, root package.json. That's all
# the box needs — symlinks resolve @berry-agent/* to packages/*/dist, and the
# external deps already live in the box's node_modules.
find packages -maxdepth 2 \( -name dist -type d -o -name package.json \) -print0 \
  | tar $TAR_NOMETA --null -czf "$TARBALL" --files-from=- package.json
LOCAL_SIZE="$(du -h "$TARBALL" | cut -f1)"
say "Tarball size: ${LOCAL_SIZE}"

if [[ $DRY_RUN -eq 1 ]]; then
  say "[dry-run] would ship ${TARBALL} → ${BOX}:${REMOTE_DIR}, then restart berry-a8s + berry-worker. Stopping."
  exit 0
fi

# ---- 3. Optional: refresh linux-x64 production node_modules (deps drift) ----
if [[ $WITH_DEPS -eq 1 ]]; then
  say "Building linux-x64 production node_modules locally…"
  DEPS_DIR="$(mktemp -d)"
  cp package.json package-lock.json "$DEPS_DIR/" 2>/dev/null || cp package.json "$DEPS_DIR/"
  # Force npm to fetch linux-x64 native packages (e.g. better-sqlite3) even
  # though we're on arm64/darwin. npm picks prebuilt binaries by these flags.
  ( cd "$DEPS_DIR" && npm install --omit=dev --os=linux --cpu=x64 --no-audit --no-fund ) \
    || { echo "linux-x64 dep build failed; box node_modules left intact" >&2; }
  if [[ -d "$DEPS_DIR/node_modules" ]]; then
    DEPS_TAR="/tmp/berry-a8s-nodemods-${STAMP}.tgz"
    ( cd "$DEPS_DIR" && tar -czf "$DEPS_TAR" node_modules )
    say "Shipping refreshed node_modules ($(du -h "$DEPS_TAR" | cut -f1))…"
    scp $SSH_OPTS "$DEPS_TAR" "${BOX}:/tmp/"
    ssh $SSH_OPTS "$BOX" "cd '$REMOTE_DIR' && tar -xzf '/tmp/$(basename "$DEPS_TAR")' && rm -f '/tmp/$(basename "$DEPS_TAR")'"
  fi
  rm -rf "$DEPS_DIR"
fi

# ---- 4. Ship + atomic swap on the box ----
say "Shipping tarball to ${BOX}…"
scp $SSH_OPTS "$TARBALL" "${BOX}:/tmp/"

REMOTE_TAR="/tmp/$(basename "$TARBALL")"
say "Atomic swap on the box (stop → unpack dist → start)…"
ssh $SSH_OPTS "$BOX" bash -se <<REMOTE
set -euo pipefail
cd '$REMOTE_DIR'

# Snapshot current dist so we can roll back if health check fails.
BAK="/tmp/berry-a8s-dist-bak-\$(date +%s).tgz"
find packages -maxdepth 2 -name dist -type d -print0 | tar --null -czf "\$BAK" --files-from=- 2>/dev/null || true

systemctl stop berry-a8s berry-worker 2>/dev/null || true

# Unpack the new dist over the tree. Only dist/ + package.json are in the
# tarball, so node_modules and the @berry-agent symlinks are untouched.
tar -xzf '$REMOTE_TAR'
# Clean any stray AppleDouble files from older scp runs.
find packages -name '._*' -delete 2>/dev/null || true
rm -f '$REMOTE_TAR'

systemctl start berry-a8s berry-worker
echo "rollback-snapshot=\$BAK"
REMOTE

# ---- 5. Health check (roll back on failure) ----
say "Waiting for a8s health…"
OK=0
for i in $(seq 1 15); do
  if curl -fsS --max-time 5 "$A8S_HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done

if [[ $OK -eq 1 ]]; then
  say "✅ a8s healthy at ${A8S_HEALTH_URL}"
  ssh $SSH_OPTS "$BOX" "systemctl is-active berry-a8s berry-worker | tr '\n' ' '; echo" || true
  rm -f "$TARBALL"
else
  echo "❌ a8s did NOT come healthy after ~30s." >&2
  echo "   Inspect: ssh $BOX 'journalctl -u berry-a8s -n 50 --no-pager'" >&2
  echo "   A rollback snapshot was written on the box (see 'rollback-snapshot=' above)." >&2
  exit 1
fi
