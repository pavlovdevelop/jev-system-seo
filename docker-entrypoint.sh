#!/bin/sh
# Starts the server as the unprivileged "node" user.
# Hosts such as Render mount persistent disks owned by root. When we start as root we hand the data directory to the
# app user first and then drop privileges. Started as a normal user (docker run --user ...), it simply runs the command.
set -e
APP_USER="${APP_USER:-node}"
DATA="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R "$APP_USER:$APP_USER" "$DATA" 2>/dev/null || echo "[entrypoint] could not change the owner of $DATA" >&2
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups "$@"
  fi
  echo "[entrypoint] setpriv is missing, running as root" >&2
fi
exec "$@"
