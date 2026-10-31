#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22.19+ from https://nodejs.org first.' >&2; exit 1; }
psi_installer=$(mktemp)
trap 'rm -f "$psi_installer"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 'https://raw.githubusercontent.com/sebastianmiletic/Psi/main/scripts/install.mjs' -o "$psi_installer"
node --input-type=module < "$psi_installer"
