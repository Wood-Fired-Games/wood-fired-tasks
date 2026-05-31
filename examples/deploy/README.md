# Deployment assets for `wft-router`

Operator-side assets for running the router as a long-lived service. None of
these is privileged over the others — pick the shape that matches your host.

## Container image

The canonical OCI image is built from
[`packages/wft-router/Containerfile`](../../packages/wft-router/Containerfile)
(this is the path the CI `oci-build` job builds, multi-arch amd64/arm64):

```sh
podman build -t wft-router -f packages/wft-router/Containerfile .
# or: docker build -t wft-router -f packages/wft-router/Containerfile .
```

## Service manifests

Host-platform service definitions live next to the package:

- systemd — [`packages/wft-router/host-manifests/systemd/wft-router.service`](../../packages/wft-router/host-manifests/systemd/wft-router.service)
- launchd (macOS) — [`packages/wft-router/host-manifests/launchd/com.wood-fired-games.wft-router.plist`](../../packages/wft-router/host-manifests/launchd/com.wood-fired-games.wft-router.plist)
- Windows service — [`packages/wft-router/host-manifests/windows/README.md`](../../packages/wft-router/host-manifests/windows/README.md)

## Log rotation

The router writes `dispatch.log` to its state directory (mode `0600`). Rotation
is the operator's responsibility; [`wft-router.logrotate`](wft-router.logrotate)
is a starting `logrotate(8)` config — copy it to `/etc/logrotate.d/wft-router`
and adjust the path to match your `--state`/state directory.
