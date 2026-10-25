#!/command/with-contenv bash
# shellcheck shell=bash

# Hardened replacement for the upstream 00-all.sh. The container runs as an
# unprivileged user from the first process, so the upstream steps that need
# root (creating the user, changing ownership) are replaced by 20-runtime.sh.

set -e

if [ "${PUID:-}" != "" ] || [ "${PGID:-}" != "" ]; then
	echo "WARNING: PUID and PGID are ignored by the hardened image, set the container user instead (user: \"uid:gid\")" >&2
fi

. /usr/bin/common.sh

if [ "$(id -u)" = "0" ]; then
	log_fatal "The hardened image must not run as root.\nSet an unprivileged user, e.g. user: \"1500:1500\" in docker compose."
fi

if [ "$DEBUG" = "true" ]; then
	set -x
fi

. /etc/s6-overlay/s6-rc.d/prepare/20-runtime.sh
. /etc/s6-overlay/s6-rc.d/prepare/40-dynamic.sh
. /etc/s6-overlay/s6-rc.d/prepare/45-admin-port.sh
. /etc/s6-overlay/s6-rc.d/prepare/50-ipv6.sh
. /etc/s6-overlay/s6-rc.d/prepare/60-secrets.sh
. /etc/s6-overlay/s6-rc.d/prepare/90-banner.sh
