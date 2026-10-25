#!/command/with-contenv bash
# shellcheck shell=bash

# Hardened copy of the upstream 90-banner.sh: PUID/PGID are not used, show the
# user the container really runs as.

set -e
set +x

echo "
-------------------------------------
 _   _ ____  __  __
| \ | |  _ \|  \/  |
|  \| | |_) | |\/| |
| |\  |  __/| |  | |
|_| \_|_|   |_|  |_|
-------------------------------------
Hardened image ${NPM_BUILD_VERSION:-} (${NPM_BUILD_COMMIT:-})
User:  $(id -un 2>/dev/null || echo '?') UID:$(id -u)
Group: $(id -gn 2>/dev/null || echo '?') GID:$(id -g)
-------------------------------------
"
