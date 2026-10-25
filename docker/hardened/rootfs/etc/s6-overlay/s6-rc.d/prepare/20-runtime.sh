#!/command/with-contenv bash
# shellcheck shell=bash

# Replaces the upstream 20-paths.sh and 30-ownership.sh. Nothing here needs
# root: the image only writes to /data, /etc/letsencrypt and to scratch paths
# that belong to the runtime user (tmpfs or volumes with a read-only root).

set -e

log_info 'Checking paths ...'

for dir in /data /etc/letsencrypt; do
	if [ ! -d "$dir" ]; then
		log_fatal "$dir is not mounted! Check your docker configuration."
	fi
	if [ ! -w "$dir" ]; then
		log_fatal "$dir is not writable by uid $(id -u), give it to $(id -u):$(id -g) on the host."
	fi
done

for dir in /run /tmp /var/cache/nginx /var/lib/nginx; do
	if [ ! -w "$dir" ]; then
		log_fatal "$dir is not writable by uid $(id -u).\nMount a tmpfs or a volume owned by this user, see docker/hardened/BUILD.md."
	fi
done

mkdir -p \
	/data/nginx \
	/data/custom_ssl \
	/data/logs \
	/data/access \
	/data/nginx/default_host \
	/data/nginx/default_www \
	/data/nginx/proxy_host \
	/data/nginx/redirection_host \
	/data/nginx/stream \
	/data/nginx/dead_host \
	/data/nginx/temp \
	/data/letsencrypt-acme-challenge \
	/data/logrotate \
	/run/nginx \
	/tmp/nginx/body \
	/var/lib/nginx/cache/public \
	/var/lib/nginx/cache/private \
	/var/cache/nginx/proxy_temp \
	"$NPMHOME"

# /etc/nginx/conf.d is a symlink to /run/nginx/conf.d: start again from the
# image's copy on every boot. The next scripts and the backend write into it.
rm -rf /run/nginx/conf.d
cp -R /etc/nginx/conf.d.dist /run/nginx/conf.d
