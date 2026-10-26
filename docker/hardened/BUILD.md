# Hardened image

A self-contained build of Nginx Proxy Manager that keeps the application as it
is upstream and only changes the image around it. Everything lives in
`docker/hardened/`, and no upstream file is modified, so merging
`upstream/develop` stays conflict-free.

| | Upstream image | Hardened image |
|---|---|---|
| Base | `nginxproxymanager/nginx-full:certbot-node` (built in another repo) | official `nginx` stable image, built here |
| Web server | OpenResty (nginx + Lua) | nginx stable + `headers-more` module |
| Node.js | 22 (nodesource) | 24 (official image binary) |
| Databases | SQLite, MySQL/MariaDB, PostgreSQL | SQLite only |
| Certbot plugins | any, `pip install`ed at runtime | baked in from a hashed lock, read-only |
| Build tools at runtime | gcc, g++, make, git, yarn, curl, wget… | none |
| User | starts as root, drops to `PUID`/`PGID` | unprivileged from the first process |
| Capabilities | `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`… | none |
| Root filesystem | writable | can be read-only |
| Test CA | trusted (its private key is public) | only in the `ci` image |
| Architectures | amd64, arm64 | amd64 |

`more_set_headers` and `more_clear_headers` keep working. Anything else that
OpenResty provides (Lua, `echo`, `set_misc`…) is gone.

## Branches

`hardened` is `upstream/develop`, plus the merged fix branches that have not
been released upstream yet, plus the commits under `docker/hardened/`. To
update it:

```sh
git fetch upstream
git switch hardened
git merge upstream/develop
# and again for any fix branch that got new commits:
git merge fix-authentication-oracle
```

Once upstream merges a fix branch, the next merge of `upstream/develop`
brings nothing new from it. After a merge, look at what changed in
[the upstream files replaced by this image](#upstream-files-replaced-here).
The build fails if one of the files patched in the Dockerfile no longer
looks as expected.

## Build

From the repository root, with Docker and buildx:

```sh
docker/hardened/scripts/build
```

This runs `docker build` on the `final` target of the Dockerfile and loads
the image into the local image store, tagged:

- `ghcr.io/alexis-loskoutoff/nginx-proxy-manager:<version>-hardened-<commit>`
- `ghcr.io/alexis-loskoutoff/nginx-proxy-manager:hardened`

The version comes from `.version` and the commit from `git`. Commit before
building, or the commit in the tag will not describe the image. The script
warns when the tree has uncommitted changes. Override any of these with
`BUILD_VERSION`, `BUILD_COMMIT`, `BUILD_DATE` or `IMAGE`.

Any extra argument goes to `docker build`, after the target:

```sh
docker/hardened/scripts/build final --no-cache
```

The frontend is built inside the Dockerfile, so `scripts/ci/frontend-build`
is not needed.

## Test

Run the full upstream Cypress suite (sqlite stack) against the image, with
the production restrictions (non-root, read-only, no capabilities):

```sh
docker/hardened/scripts/test-cypress          # add --keep to leave the stack up
```

It builds the `ci` target and runs `scripts/ci/fulltest-cypress` with
`docker/hardened/docker-compose.ci.yml` on top of the upstream CI compose
files. Results land in `test/results/`. The `ci` image adds the PowerDNS
plugin and trusts the public test CA, so never deploy it.

To scan the production image for known vulnerabilities:

```sh
trivy image ghcr.io/alexis-loskoutoff/nginx-proxy-manager:hardened
```

## Push

ghcr.io needs a personal access token (classic) with the `write:packages`
scope:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u Alexis-Loskoutoff --password-stdin
docker push ghcr.io/alexis-loskoutoff/nginx-proxy-manager:<version>-hardened-<commit>
docker push ghcr.io/alexis-loskoutoff/nginx-proxy-manager:hardened
```

`docker push` prints the digest. Deploy that digest, not the tag:

```yaml
image: ghcr.io/alexis-loskoutoff/nginx-proxy-manager:2.16.0-hardened-abc1234@sha256:<digest>
```

A new package on ghcr.io is private. Make it public in the package settings
if the server pulls it without logging in.

## Run

```yaml
services:
  npm:
    image: ghcr.io/alexis-loskoutoff/nginx-proxy-manager:<tag>@sha256:<digest>
    restart: unless-stopped
    user: "1500:1500"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    environment:
      TZ: Europe/Paris
      DISABLE_IPV6: "true"
    ports:
      - "80:80"
      - "443:443"
      - "81:81"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
      # Disk-backed scratch space. Uploads are buffered in /tmp/nginx/body,
      # large responses in /var/cache/nginx and the proxy cache lives in
      # /var/lib/nginx, so a tmpfs (counted in the memory limit) is a bad fit.
      - npm_tmp:/tmp
      - npm_nginx_cache:/var/cache/nginx
      - npm_nginx_lib:/var/lib/nginx
    tmpfs:
      - /run:exec,uid=1500,gid=1500,mode=0755,size=16m

volumes:
  npm_tmp:
  npm_nginx_cache:
  npm_nginx_lib:
```

- **User.** `data/` and `letsencrypt/` on the host must belong to the
  container user. New named volumes get the right owner from the image.
  Another uid works if the user owns every writable path: build with
  `docker/hardened/scripts/build final --build-arg NPM_UID=… --build-arg NPM_GID=…`,
  or change the `uid`/`gid` of the tmpfs and make the volumes yours.
- **Permissions.** On every start, `/data` and `/etc/letsencrypt` are set to
  `0700`: the database (DNS credentials included) and imported private keys
  are created world-readable inside them. Anything on the host that reads the
  nginx logs must therefore get them from a separate mount on `/data/logs`,
  not through `data/logs`.
- **Capabilities.** None are needed. Docker lets unprivileged processes bind
  ports below 1024 inside the container (`net.ipv4.ip_unprivileged_port_start=0`).
- **`/run`.** s6-overlay refuses a `/run` that root owns and anyone can write,
  which is Docker's tmpfs default, hence the `uid`, `gid` and `mode`. It also
  runs its init from `/run`, so the tmpfs must be `exec` (Docker mounts it
  `noexec` by default).
- **Read-only root.** Without `read_only` and the mounts above, the image
  still works, using its own writable layer.
- **Healthcheck.** The image defines one (`/usr/bin/check-health`).

### Coming from the upstream image

- Remove `PUID`/`PGID` and every `cap_add`. The image warns if `PUID`/`PGID`
  are still set, and ignores them.
- Keep `data/` and `letsencrypt/` as they are. With `PUID=1500` they already
  belong to `1500:1500`.
- Advanced configs that use `more_set_headers` keep working. Lua directives
  do not.
- On first start the backend runs `pip install` for every DNS provider in
  use. Each one must be baked in (see below), or the backend never finishes
  starting.

## Certbot plugins

Only `certbot-dns-infomaniak` is installed, and HTTP-01 needs nothing extra.
The backend cannot install plugins at runtime: the venv is read-only. To add
a DNS provider:

1. Add its package to `certbot/requirements.in`, with a version that
   satisfies `backend/certbot/dns-plugins.json`.
2. Add its key from `dns-plugins.json` to the `check-plugins.py` call in the
   `certbot` stage of the Dockerfile.
3. Run `docker/hardened/scripts/lock-certbot`.

The build fails if an installed plugin does not satisfy `dns-plugins.json`,
since the backend would then try to download it at startup.

## Pinned versions

Everything the build downloads is pinned and checked:

| What | Where | How to update |
|---|---|---|
| Dockerfile syntax | first line of `Dockerfile` | tag + digest from `docker buildx imagetools inspect docker/dockerfile:<version>` |
| nginx | `NGINX_IMAGE` | stable tag + digest. Then set `PKG_OSS_COMMIT` to the commit of the [pkg-oss](https://github.com/nginx/pkg-oss/tags) tag `<nginx version>-1` (the build checks they match) |
| headers-more | through `PKG_OSS_COMMIT` | pkg-oss pins the module and its SHA512 |
| Node.js | `NODE_IMAGE`, `NODE_BUILD_IMAGE` | same version and Debian release for both |
| s6-overlay | `S6_OVERLAY_VERSION` + the two `ADD --checksum` | checksums from the release's `.sha256` files |
| certbot and plugins | `certbot/requirements*.txt` | `docker/hardened/scripts/lock-certbot` |
| npm packages | `backend/yarn.lock`, `frontend/yarn.lock` | upstream |
| test CA (`ci` only) | `TESTCA_IMAGE` | digest |

Base image digests cover only the image as published. Rebuild regularly so
Debian security updates reach the image: the nginx image is rebuilt upstream
under the same tag, so update the digest.

## Upstream files replaced here

`docker/hardened/rootfs/` is copied over `docker/rootfs/`. When upstream
changes one of these, port the change if it applies:

| Upstream file | Why it is replaced |
|---|---|
| `etc/s6-overlay/s6-rc.d/prepare/00-all.sh` | refuses root and skips the root-only steps |
| `prepare/10-usergroup.sh`, `20-paths.sh`, `30-ownership.sh` | removed, replaced by `prepare/20-runtime.sh` (no `useradd`, no `chown`) |
| `prepare/50-ipv6.sh` | `conf.d` is a symlink to `/run/nginx/conf.d`, no `chown` |
| `prepare/90-banner.sh` | shows the real uid/gid |
| `s6-rc.d/backend/run`, `s6-rc.d/nginx/run` | no `s6-setuidgid` (needs `CAP_SETGID`) |
| `usr/bin/check-health` | Node instead of curl + jq |

The Dockerfile also edits these, and fails if they changed:

- `nginx.conf`: drops `user npm;` (the master is not root). It must still
  include `/etc/nginx/modules/*.conf`, which loads headers-more.
- `logrotate.d/nginx-proxy-manager`: drops `su npm npm`, which needs root.
- s6: the upstream `s6-rc.d/user` bundle (deprecated) moves to
  `user-bundles.d/user`, since s6-overlay writes into the old one at boot.

At build time, `/etc/nginx/conf.d` moves to `conf.d.dist`, and boot copies it
to `/run/nginx/conf.d`. Bind-mounting files into `/etc/nginx/conf.d` is
therefore not supported.

The backend tests configs with `nginx -t -g "error_log off;"`. nginx has no
`off` value for `error_log`, so this logs to a file named `off` in the nginx
prefix. With OpenResty that prefix is `/etc/nginx/nginx`, which upstream makes
writable. Here it is `/etc/nginx`, so `/etc/nginx/off` links to `/dev/null`.

## Not covered

- Only SQLite: the MySQL/MariaDB and PostgreSQL drivers are not installed,
  and neither is the legacy `sqlite3` client used by old `config/production.json` files.
- Only linux/amd64.
- The image is built and pushed by hand, there is no CI workflow.
