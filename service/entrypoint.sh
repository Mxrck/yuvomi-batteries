#!/bin/sh
# Root entrypoint, the same pattern Yuvomi's own image uses: fix volume ownership, publish the
# module page into the shared modules folder, then drop to the unprivileged node user.
# setpriv instead of gosu: gosu hangs under no-new-privileges (Podman/crun) while setpriv does
# not; setpriv keeps HOME, so it is pointed at node's home or the process would see /root.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$(dirname "$DB_PATH")"
  chown -R node:node "$(dirname "$DB_PATH")"

  # /modules-out is Yuvomi's modules folder (a host share). Publish only when the version
  # changed; Yuvomi discovers it on its next scan, without a restart.
  if [ -d /modules-out ]; then
    node /app/install-module.mjs || echo '{"msg":"install-module failed; continuing without publishing the module page"}' >&2
  fi

  HOME=$(getent passwd node | cut -d: -f6)
  export HOME
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
