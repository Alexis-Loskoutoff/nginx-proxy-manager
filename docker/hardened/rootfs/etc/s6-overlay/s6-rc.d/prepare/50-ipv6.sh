#!/command/with-contenv bash
# shellcheck shell=bash

# Hardened copy of the upstream 50-ipv6.sh, which reads the `DISABLE_IPV6`
# env var and enables or disables ipv6 in all nginx configs. /etc/nginx/conf.d
# is a symlink here, which `find` does not descend into, so the real folder is
# given instead. The files already belong to the runtime user, so the upstream
# chown is dropped (it fails without CAP_CHOWN).

set -e

log_info 'IPv6 ...'

process_folder () {
	FILES=$(find "$1" -type f -name "*.conf")
	SED_REGEX=

	if [ "$(is_true "${DISABLE_IPV6:-}")" = '1' ]; then
		# IPV6 is disabled
		echo "Disabling IPV6 in hosts in: $1"
		SED_REGEX='s/^([^#]*)listen \[::\]/\1#listen [::]/g'
	else
		# IPV6 is enabled
		echo "Enabling IPV6 in hosts in: $1"
		SED_REGEX='s/^(\s*)#listen \[::\]/\1listen [::]/g'
	fi

	for FILE in $FILES
	do
		echo "- ${FILE}"
		TMPFILE="${FILE}.tmp"

		if is_mounted "${FILE}"; then
			echo "WARNING: skipping ${FILE} — mounted file" >&2
		elif sed -E "$SED_REGEX" "$FILE" > "$TMPFILE" && [ -s "$TMPFILE" ]; then
			mv "$TMPFILE" "$FILE"
		else
			echo "WARNING: skipping ${FILE} — sed produced empty output" >&2
			rm -f "$TMPFILE"
		fi
	done
}

process_folder /run/nginx/conf.d
process_folder /data/nginx
