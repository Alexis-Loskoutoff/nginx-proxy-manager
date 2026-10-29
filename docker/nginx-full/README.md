# nginx-full (temporary copy)

`docker/` is a copy of the `docker/` folder of
[docker-nginx-full](https://github.com/NginxProxyManager/docker-nginx-full)
at commit `46259d0da64a25de676fc52ed1cd7142fe05769a`, which builds the
`nginxproxymanager/nginx-full` images. It lets this repo ship an OpenResty
update, and the nginx security fixes that come with it, before the
published image is updated.

Changes from that commit are `OPENRESTY_VERSION` in
`docker/docker-bake.hcl`, from `1.31.1.1` to `1.31.8.1`, and HTTPS URLs
for the Lua and LuaRocks downloads in `docker/scripts/build-lua.sh`.
To check them:

```bash
git clone https://github.com/NginxProxyManager/docker-nginx-full
git -C docker-nginx-full checkout 46259d0
diff -r docker-nginx-full/docker docker/nginx-full/docker
```

`scripts/ci/test-and-build` runs `scripts/nginx-full`, which builds the
`certbot-node` target for amd64 and arm64 and pushes it as
`nginxproxymanager/nginx-proxy-manager-dev:nginx-full-<branch>-<build>-certbot-node`.
`scripts/ci/test-and-build` and `scripts/buildx` then use it as the base
image, so `scripts/buildx` needs `scripts/nginx-full` to have run first
with the same `BRANCH_LOWER` and `BUILD_NUMBER`.

Once the published image ships the update, delete this folder and
`scripts/nginx-full`, and revert their use in `scripts/.common.sh`,
`scripts/buildx` and `scripts/ci/test-and-build`.
