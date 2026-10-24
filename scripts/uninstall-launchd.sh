#!/bin/zsh
# Stops the broker and removes its launchd agent. The repo, token and logs are left in place.
LABEL=${AGENT_TABS_LABEL:-local.agent-tabs.broker}
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null && echo "Stopped $LABEL" || echo "$LABEL was not loaded"
rm -f ~/Library/LaunchAgents/$LABEL.plist
