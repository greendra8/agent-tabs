#!/bin/zsh
# Installs and (re)starts the broker as a launchd agent (macOS), so it runs at login and restarts
# if it stops. Override the label with AGENT_TABS_LABEL and the node binary with NODE.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
LABEL=${AGENT_TABS_LABEL:-local.agent-tabs.broker}
# A stable node path: version-manager shims (fnm, nvm) can change between shells.
NODE=${NODE:-$(for n in /opt/homebrew/bin/node /usr/local/bin/node; do [[ -x $n ]] && echo $n && break; done)}
NODE=${NODE:-$(command -v node)}
PLIST=~/Library/LaunchAgents/$LABEL.plist
LOGS=~/Library/Logs/agent-tabs
mkdir -p "$LOGS" ~/Library/LaunchAgents
"$NODE" scripts/setup.mjs
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/broker/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/broker.log</string>
  <key>StandardErrorPath</key><string>$LOGS/broker.log</string>
</dict>
</plist>
PLIST
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 1
curl -s http://127.0.0.1:47615/health && echo
