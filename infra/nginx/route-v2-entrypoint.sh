#!/bin/sh
set -eu

mkdir -p /tmp/nginx-conf.d
exec /docker-entrypoint.sh "$@"
