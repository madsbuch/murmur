#!/usr/bin/env bash
# Hosted runners sometimes share a Maven Central IP that is temporarily throttled.
# Retry only transport/download failures; compile errors still fail immediately.
set -euo pipefail

build_log="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/murmur-android-build.XXXXXX")"
trap 'rm -f "$build_log"' EXIT

for attempt in 1 2 3; do
  set +e
  npm run tauri -- android build --ci --apk --target aarch64 --target armv7 2>&1 | tee "$build_log"
  build_status=${PIPESTATUS[0]}
  set -e
  if [[ "$build_status" -eq 0 ]]; then
    exit 0
  fi

  if [[ "$attempt" -eq 3 ]] || ! grep -Eiq 'status code (429|502|503|504)|HTTP[^[:alnum:]]*(429|502|503|504)|Too Many Requests|Connection timed out|Read timed out|Connection reset' "$build_log"; then
    exit "$build_status"
  fi

  delay=$((attempt * 30))
  printf '::warning::Dependency download temporarily failed; retrying in %s seconds (attempt %s/3).\n' "$delay" "$((attempt + 1))"
  sleep "$delay"
done
