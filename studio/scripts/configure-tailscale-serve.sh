#!/bin/sh
set -eu

# Serve persists these mappings across Tailscale restarts. Running this again
# at login restores the intended configuration if it was removed.
tailscale serve --bg --https=3000 3000
tailscale serve --bg --https=3473 3473
