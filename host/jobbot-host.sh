#!/bin/sh
# Started by Firefox (native messaging). Absolute node path: Firefox's PATH may be minimal.
exec /usr/bin/node "$(dirname "$0")/jobbot-host.js" "$@"
