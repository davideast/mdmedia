#!/bin/bash
set -eu

studio="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$studio/.pyric"
exec >> "$studio/.pyric/windows-startup.log" 2>&1
date -Is
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

# The user manager can still be starting when Windows launches WSL at boot.
for attempt in {1..60}; do
  if systemctl --user start mdmedia-studio.service; then
    echo 'Studio service started; keeping WSL active.'
    exec /bin/sleep infinity
  fi
  sleep 2
done
echo 'Studio user service did not start within two minutes.' >&2
exit 1
