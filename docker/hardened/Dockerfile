# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

# Hardened Nginx Proxy Manager image, self-contained (no nginx-full base image):
# - official nginx stable image instead of OpenResty, plus headers-more
# - Node 24, SQLite only, no compiler, package manager or curl at runtime
# - certbot and its DNS plugins locked with hashes and read-only at runtime
# - runs as an unprivileged user from the first process, supports a
#   read-only root filesystem and no capabilities at all
#
# Build it from the repository root with docker/hardened/scripts/build,
# see docker/hardened/BUILD.md.

# Base images are pinned by digest, the tag is only there for humans.
# NGINX_IMAGE must stay on the version that PKG_OSS_COMMIT is tagged for.
ARG NGINX_IMAGE=nginx:1.30.6-trixie@sha256:a7675fcee220f59b4a99f7098c06a0d5d999c2c0ee37c0211efb780536e5cb20
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ARG NODE_BUILD_IMAGE=node:24.22.1-trixie@sha256:016f604a11c4c725f0a4c62e29ff11adab153d297bf97046c9bf2ddb9f1011d3
ARG TESTCA_IMAGE=nginxproxymanager/testca@sha256:3e23c78c64789b8e95126589dd502127e57bbad6091a5a88a67ffb87a16f6b6a

# Owner of the writable paths inside the image. The container should run
# with this uid:gid (user: "1500:1500"), see BUILD.md to use another one.
ARG NPM_UID=1500
ARG NPM_GID=1500

#############
# headers-more dynamic module, built with nginx's own packaging (pkg-oss)
# for the exact nginx version of the base image. pkg-oss pins the nginx and
# module sources and checks their SHA512 before building.
#############

FROM ${NGINX_IMAGE} AS nginx-modules

SHELL ["/bin/bash", "-exo", "pipefail", "-c"]

# Tag 1.30.6-1 of https://github.com/nginx/pkg-oss
ARG PKG_OSS_COMMIT=3e9e3b9f85308c0bb7b1cf849c87d1f7df98dfc3
# Same pinned helper as nginx's docker-nginx/modules/Dockerfile
ARG XSLSCRIPT_COMMIT=9204424259c343ca08a18a78915f40f28025e093
ARG XSLSCRIPT_SHA512=f7194c5198daeab9b3b0c3aebf006922c7df1d345d454bd8474489ff2eb6b4bf8e2ffe442489a45d1aab80da6ecebe0097759a1e12cc26b5f0613d05b7c09ffa

RUN apt-get update \
	&& apt-get install -y --no-install-suggests --no-install-recommends \
		build-essential ca-certificates debhelper devscripts dpkg-dev equivs g++ git \
		libparse-recdescent-perl libxml2-utils lsb-release make patch quilt wget xsltproc

RUN wget -qO /usr/local/bin/xslscript.pl "https://raw.githubusercontent.com/nginx/xslscript/${XSLSCRIPT_COMMIT}/xslscript.pl" \
	&& echo "${XSLSCRIPT_SHA512}  /usr/local/bin/xslscript.pl" | sha512sum -c - \
	&& chmod +x /usr/local/bin/xslscript.pl

RUN git init -q /pkg-oss \
	&& git -C /pkg-oss fetch -q --depth 1 https://github.com/nginx/pkg-oss.git "${PKG_OSS_COMMIT}" \
	&& git -C /pkg-oss checkout -q FETCH_HEAD \
	&& if ! grep -qx "NGINX_VERSION := ${NGINX_VERSION}" /pkg-oss/contrib/src/nginx/version; then \
		echo "pkg-oss ${PKG_OSS_COMMIT} is not for nginx ${NGINX_VERSION}, update PKG_OSS_COMMIT"; \
		exit 1; \
	fi

WORKDIR /pkg-oss/debian
RUN make rules-module-headers-more BASE_VERSION="${NGINX_VERSION}" NGINX_VERSION="${NGINX_VERSION}" \
	&& mk-build-deps --install --tool="apt-get -o Debug::pkgProblemResolver=yes --no-install-recommends --yes" \
		"debuild-module-headers-more/nginx-${NGINX_VERSION}/debian/control" \
	&& make module-headers-more BASE_VERSION="${NGINX_VERSION}" NGINX_VERSION="${NGINX_VERSION}" \
	&& mkdir /packages \
	&& find / -maxdepth 1 -type f -name "nginx-module-headers-more_${NGINX_VERSION}*.deb" -exec mv -v {} /packages/ \; \
	&& ls /packages/*.deb

#############
# Certbot in a venv, from a lock with hashes. Built on the nginx image so the
# venv matches the Python of the final image.
#############

FROM ${NGINX_IMAGE} AS certbot-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
	PIP_NO_CACHE_DIR=1

RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 python3-venv \
	&& python3 -m venv /opt/certbot

COPY backend/certbot/dns-plugins.json docker/hardened/certbot/check-plugins.py /tmp/

FROM certbot-base AS certbot

COPY docker/hardened/certbot/requirements.txt /tmp/requirements.txt
RUN /opt/certbot/bin/pip install --require-hashes --only-binary=:all: --no-deps -r /tmp/requirements.txt \
	&& /opt/certbot/bin/python /tmp/check-plugins.py /tmp/dns-plugins.json infomaniak

# CI only: adds the PowerDNS plugin used by the Cypress suite. It only ships
# as an sdist, so this one is built from source.
FROM certbot-base AS certbot-ci

COPY docker/hardened/certbot/requirements-ci.txt /tmp/requirements-ci.txt
RUN /opt/certbot/bin/pip install --require-hashes --no-deps -r /tmp/requirements-ci.txt \
	&& /opt/certbot/bin/python /tmp/check-plugins.py /tmp/dns-plugins.json infomaniak powerdns

#############
# Backend: production dependencies only, native modules compiled here
#############

FROM ${NODE_BUILD_IMAGE} AS backend

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG BUILD_VERSION

# Native modules are built from the lockfile-checked sources against the
# headers of this Node, so no prebuilt binary is downloaded
ENV npm_config_build_from_source=true \
	npm_config_nodedir=/usr/local

WORKDIR /app
COPY backend/package.json backend/yarn.lock ./

# SQLite only: drop the MySQL/MariaDB and PostgreSQL drivers, and the legacy
# sqlite3 client (only used by old config files), before installing. The
# remaining packages keep the versions locked in yarn.lock.
RUN node -e ' \
		const fs = require("node:fs"); \
		const pkg = JSON.parse(fs.readFileSync("package.json")); \
		for (const name of ["mysql2", "pg", "sqlite3"]) { \
			if (!pkg.dependencies[name]) throw new Error(`${name} is no longer a dependency`); \
			delete pkg.dependencies[name]; \
		} \
		fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t")); \
	' \
	&& cp package.json /tmp/package.json \
	&& yarn install --production --frozen-lockfile --non-interactive \
	&& yarn cache clean

COPY backend/ ./

# Keep the trimmed package.json, and report the real version in the API
RUN cp /tmp/package.json package.json \
	&& if [ -n "${BUILD_VERSION}" ]; then \
		node -e ' \
			const fs = require("node:fs"); \
			const pkg = JSON.parse(fs.readFileSync("package.json")); \
			pkg.version = process.argv[1]; \
			fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t")); \
		' "${BUILD_VERSION}"; \
	fi

#############
# Frontend: static files only, built on the build platform
#############

FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS frontend

WORKDIR /app/frontend
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive \
	&& yarn cache clean

COPY frontend/ ./
RUN yarn locale-compile \
	&& yarn build

#############
# s6-overlay, checked against the release checksums
#############

FROM ${NODE_BUILD_IMAGE} AS s6

ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.3.2

ADD --checksum=sha256:5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12 \
	https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
ADD --checksum=sha256:e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408 \
	https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/

# Only the x86_64 tarball is pinned above
RUN if [ "${TARGETARCH}" != "amd64" ]; then \
		echo "Only linux/amd64 is supported, got ${TARGETARCH}"; \
		exit 1; \
	fi \
	&& mkdir /s6 \
	&& tar -C /s6 -Jxpf /tmp/s6-overlay-noarch.tar.xz \
	&& tar -C /s6 -Jxpf /tmp/s6-overlay-x86_64.tar.xz

FROM ${NODE_IMAGE} AS node

FROM ${TESTCA_IMAGE} AS testca

#############
# Runtime, everything but certbot
#############

FROM ${NGINX_IMAGE} AS runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG NPM_UID
ARG NPM_GID

# Drop what NPM does not use from the nginx image (njs, ACME, GeoIP,
# image-filter and XSLT modules with their libraries, curl, envsubst and the
# image's entrypoint), then add the runtime dependencies and headers-more
RUN --mount=type=bind,from=nginx-modules,source=/packages,target=/tmp/packages \
	apt-get update \
	&& apt-get purge -y --auto-remove \
		curl \
		gettext-base \
		nginx-module-acme \
		nginx-module-geoip \
		nginx-module-image-filter \
		nginx-module-njs \
		nginx-module-xslt \
	&& apt-get install -y --no-install-recommends \
		libstdc++6 \
		logrotate \
		openssl \
		python3 \
		/tmp/packages/nginx-module-headers-more_*.deb \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log \
		/docker-entrypoint.sh /docker-entrypoint.d \
		/usr/lib/nginx/modules/*-debug.so

RUN groupadd --gid "${NPM_GID}" npm \
	&& useradd --uid "${NPM_UID}" --gid npm --no-create-home --home-dir /tmp/npmuserhome \
		--shell /usr/sbin/nologin npm

COPY --from=s6 /s6/ /
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=backend /app /app
COPY --from=frontend /app/frontend/dist /app/frontend
COPY docker/rootfs /
COPY docker/hardened/rootfs /

# Adapt the upstream rootfs. Every edit checks that the upstream file still
# looks as expected, so an upstream change fails the build instead of being
# silently skipped.
RUN fail () { echo "ERROR: $1, docker/hardened needs updating"; exit 1; } \
	# Development only, as in docker/Dockerfile
	&& rm -rf /etc/s6-overlay/s6-rc.d/user/contents.d/frontend /etc/s6-overlay/s6-rc.d/frontend \
		/etc/nginx/conf.d/dev.conf \
	# s6-overlay writes into the deprecated s6-rc.d/user bundle on boot, which
	# a read-only root forbids: move its contents to user-bundles.d
	&& { [ -d /etc/s6-overlay/s6-rc.d/user/contents.d ] || fail "no s6-rc.d/user bundle"; } \
	&& mv /etc/s6-overlay/s6-rc.d/user/contents.d/* /etc/s6-overlay/user-bundles.d/user/contents.d/ \
	&& rm -r /etc/s6-overlay/s6-rc.d/user \
	# Root-only steps of the upstream init, replaced by prepare/20-runtime.sh
	&& rm -f /etc/s6-overlay/s6-rc.d/prepare/10-usergroup.sh \
		/etc/s6-overlay/s6-rc.d/prepare/20-paths.sh \
		/etc/s6-overlay/s6-rc.d/prepare/30-ownership.sh \
	# The master process is not root, the user directive would only warn
	&& { grep -qx 'user npm;' /etc/nginx/nginx.conf || fail "nginx.conf has no 'user npm;'"; } \
	&& sed -i '/^user npm;$/d' /etc/nginx/nginx.conf \
	# headers-more is loaded from modules/headers-more.conf through this include
	&& { grep -qF 'include /etc/nginx/modules/*.conf;' /etc/nginx/nginx.conf || fail "nginx.conf no longer includes modules/*.conf"; } \
	# logrotate already runs as the log owner, su needs root
	&& { grep -qE '^\s*su npm npm$' /etc/logrotate.d/nginx-proxy-manager || fail "logrotate config has no 'su npm npm'"; } \
	&& sed -i -E '/^\s*su npm npm$/d' /etc/logrotate.d/nginx-proxy-manager \
	# Everything written at runtime lives on /run, /tmp or a volume:
	# conf.d is copied to /run/nginx/conf.d on boot, logrotate keeps its state
	# in /data, and the error log nginx opens before reading its config is the
	# same file as the one nginx.conf sets
	&& mv /etc/nginx/conf.d /etc/nginx/conf.d.dist \
	&& ln -s /run/nginx/conf.d /etc/nginx/conf.d \
	&& rm -rf /var/lib/logrotate \
	&& ln -s /data/logrotate /var/lib/logrotate \
	&& rm -f /var/log/nginx/access.log /var/log/nginx/error.log \
	&& ln -s /data/logs/fallback_error.log /var/log/nginx/error.log \
	# The backend tests configs with `nginx -t -g "error_log off;"`, which logs
	# to a file named "off" in the nginx prefix (/etc/nginx here, a writable
	# /etc/nginx/nginx with OpenResty). Send it where it was meant to go
	&& ln -s /dev/null /etc/nginx/off \
	&& ln -s /opt/certbot/bin/certbot /usr/bin/certbot \
	# Writable paths belong to the runtime user. With a read-only root
	# filesystem they are tmpfs or volumes instead, see BUILD.md
	&& mkdir -p /data /etc/letsencrypt /var/cache/nginx /var/lib/nginx \
	&& chown "${NPM_UID}:${NPM_GID}" /data /etc/letsencrypt /run /var/cache/nginx /var/lib/nginx \
	# Nothing may gain privileges in the container: no setuid/setgid binaries,
	# including s6-overlay-suexec, which only needs root to start as root
	&& find / -xdev -type f -perm /6000 -exec chmod a-s {} +

# Sanity checks: headers-more loads, and the native Node modules work
RUN mkdir /tmp/nginx-test \
	&& printf '%s\n' \
		'pid /tmp/nginx-test/nginx.pid;' \
		'include /etc/nginx/modules/*.conf;' \
		'events {}' \
		'http {' \
		'  client_body_temp_path /tmp/nginx-test/body; proxy_temp_path /tmp/nginx-test/proxy;' \
		'  fastcgi_temp_path /tmp/nginx-test/fastcgi; uwsgi_temp_path /tmp/nginx-test/uwsgi;' \
		'  scgi_temp_path /tmp/nginx-test/scgi;' \
		'  access_log off;' \
		'  more_set_headers "X-Test: ok";' \
		'}' > /tmp/nginx-test/nginx.conf \
	&& nginx -e stderr -t -q -c /tmp/nginx-test/nginx.conf \
	&& rm -rf /tmp/nginx-test \
	&& cd /app \
	&& node -e 'new (require("better-sqlite3"))(":memory:").prepare("select 1").get(); require("bcrypt").hashSync("x", 4);'

ARG BUILD_VERSION
ARG BUILD_COMMIT
ARG BUILD_DATE

# See https://github.com/just-containers/s6-overlay/blob/master/README.md
ENV SUPPRESS_NO_CONFIG_WARNING=1 \
	S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
	S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
	S6_FIX_ATTRS_HIDDEN=1 \
	S6_KILL_FINISH_MAXTIME=10000 \
	S6_READ_ONLY_ROOT=1 \
	S6_VERBOSITY=1 \
	NODE_ENV=production \
	PIP_DISABLE_PIP_VERSION_CHECK=1 \
	PYTHONDONTWRITEBYTECODE=1 \
	NPM_BUILD_VERSION="${BUILD_VERSION}" \
	NPM_BUILD_COMMIT="${BUILD_COMMIT}" \
	NPM_BUILD_DATE="${BUILD_DATE}"

USER ${NPM_UID}:${NPM_GID}
WORKDIR /app

EXPOSE 80 81 443
VOLUME [ "/data" ]
ENTRYPOINT [ "/init" ]
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s CMD [ "/usr/bin/check-health" ]

LABEL org.opencontainers.image.title="nginx-proxy-manager (hardened)" \
	org.opencontainers.image.description="Nginx Proxy Manager on official nginx stable, unprivileged and read-only" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.source="https://github.com/Alexis-Loskoutoff/nginx-proxy-manager" \
	org.opencontainers.image.version="${BUILD_VERSION}" \
	org.opencontainers.image.revision="${BUILD_COMMIT}" \
	org.opencontainers.image.created="${BUILD_DATE}"

#############
# CI image for the upstream Cypress suite: the PowerDNS plugin and the
# public test CA, whose private key ships in the testca image. Never deploy it.
#############

FROM runtime AS ci

ARG NPM_UID
ARG NPM_GID

COPY --from=certbot-ci /opt/certbot /opt/certbot
COPY --from=testca /home/step/certs/root_ca.crt /etc/ssl/certs/NginxProxyManager.crt

USER root
RUN ln -s NginxProxyManager.crt "/etc/ssl/certs/$(openssl x509 -hash -noout -in /etc/ssl/certs/NginxProxyManager.crt).0" \
	&& certbot --version
USER ${NPM_UID}:${NPM_GID}

#############
# Production image (default target)
#############

FROM runtime AS final

COPY --from=certbot /opt/certbot /opt/certbot
RUN certbot --version
