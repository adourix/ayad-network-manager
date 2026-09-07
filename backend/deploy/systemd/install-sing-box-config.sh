#!/usr/bin/env bash
set -euo pipefail

SOURCE="/run/network-control/sing-box-config.json"
TARGET="/etc/sing-box/config.json"
TEMP="/etc/sing-box/config.json.tmp"
BACKUP="/etc/sing-box/config.json.bak"

if [[ ! -f "${SOURCE}" ]]; then
  echo "sing-box staged config not found: ${SOURCE}" >&2
  exit 1
fi

if [[ -L "${TARGET}" ]]; then
  echo "refusing to replace symlinked sing-box config: ${TARGET}" >&2
  exit 1
fi

rm -f "${TEMP}"
install -o sing-box -g sing-box -m 0600 "${SOURCE}" "${TEMP}"

if [[ -f "${TARGET}" ]]; then
  install -o sing-box -g sing-box -m 0600 "${TARGET}" "${BACKUP}"
fi

mv -f "${TEMP}" "${TARGET}"
chown sing-box:sing-box "${TARGET}"
chmod 0600 "${TARGET}"
rm -f "${SOURCE}"
