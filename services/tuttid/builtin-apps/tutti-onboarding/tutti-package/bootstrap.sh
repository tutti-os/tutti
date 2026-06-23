#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
app_package_dir="${TUTTI_APP_PACKAGE_DIR:-$script_dir}"
app_runtime_dir="${TUTTI_APP_RUNTIME_DIR:-$PWD}"
app_data_dir="${TUTTI_APP_DATA_DIR:-$app_runtime_dir/data}"
app_host="${TUTTI_APP_HOST:-127.0.0.1}"
app_port="${TUTTI_APP_PORT:-3003}"

mkdir -p "$app_data_dir"

export TUTTI_APP_PACKAGE_DIR="$app_package_dir"
export TUTTI_APP_DATA_DIR="$app_data_dir"
export TUTTI_APP_HOST="$app_host"
export TUTTI_APP_PORT="$app_port"

os_name="$(uname -s)"
arch_name="$(uname -m)"
case "$os_name:$arch_name" in
  Darwin:arm64) platform="darwin-arm64" ;;
  Darwin:x86_64) platform="darwin-amd64" ;;
  *)
    echo "unsupported tutti-onboarding platform: $os_name $arch_name" >&2
    exit 1
    ;;
esac

exec "$app_package_dir/bin/$platform/tutti-onboarding-server"
