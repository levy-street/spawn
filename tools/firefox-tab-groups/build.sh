#!/bin/sh
# Builds dist/spawn-tab-groups-<version>.xpi (the Firefox add-on) and
# dist/spawn-tab-groups.user.js (the same script for Violentmonkey/Tampermonkey).
set -eu
cd "$(dirname "$0")"
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json | head -n 1)
rm -rf dist && mkdir dist

zip -q -X "dist/spawn-tab-groups-$version.xpi" manifest.json content.js icons/icon.svg

{
  cat <<EOF
// ==UserScript==
// @name         SPAWN D Tab Groups
// @namespace    spawn-tab-groups
// @version      $version
// @description  Firefox-style tab groups for SPAWN D workspace tabs.
// @match        https://spawnd.dev/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

EOF
  cat content.js
} > dist/spawn-tab-groups.user.js

ls -l dist
