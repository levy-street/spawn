#!/bin/bash
# Drives the app in the booted iOS simulator via Expo Go and captures each screen.
# Requires: booted simulator with Expo Go 54, Metro serving on $HOST.
set -uo pipefail
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
HOST="${SPAWN_METRO_HOST:-192.168.88.6:8081}"
SHOTS="${SPAWN_SHOTS:-/tmp/spawn-shots}"
mkdir -p "$SHOTS"

shot() { xcrun simctl io booted screenshot "$SHOTS/$1.png" >/dev/null 2>&1 && echo "  captured $1"; }
goto() {
  xcrun simctl openurl booted "exp://$HOST/--$1" >/dev/null 2>&1
  sleep "${3:-6}"
  shot "$2"
}

echo "== relaunching app =="
xcrun simctl terminate booted host.exp.Exponent >/dev/null 2>&1
xcrun simctl openurl booted "exp://$HOST" >/dev/null 2>&1
sleep 35
maestro test e2e/flows/dismiss-devmenu.yaml >/dev/null 2>&1 || true
sleep 2
shot "00-launch"

echo "== capturing routes =="
goto "/login"                 "01-login"
goto "/signup"                "02-signup"
goto "/forgot-password"       "03-forgot"
goto "/server"                "04-server"
goto "/workspaces"            "05-workspaces" 8
goto "/workspaces/archived"   "06-archived"
goto "/hosts"                 "07-hosts"
goto "/legion"                "08-legion"
goto "/settings"              "09-settings"
goto "/settings/appearance"   "10-appearance"
goto "/settings/notifications" "11-notifications"
goto "/settings/devices"      "12-devices"
goto "/settings/trust"        "13-trust"
goto "/settings/agents"       "14-agents"
goto "/settings/profile"      "15-profile"
goto "/settings/about"        "16-about"
goto "/onboarding"            "17-onboarding"
echo "== done: $SHOTS =="
ls "$SHOTS" | wc -l | xargs echo "screens captured:"
