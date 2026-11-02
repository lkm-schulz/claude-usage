#!/bin/sh
# Installs (or with "remove", removes) a launchd agent that runs collect.mjs every day at 09:00 and at login.
# launchd starts a run missed during sleep at the next wake.
set -eu
LABEL=local.claude-usage
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Paths go into XML, so &, < and > are escaped.
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
DIR=$(xml "$(cd "$(dirname "$0")" && pwd)")
NODE=$(command -v node)
NODE_DIR=$(xml "$(dirname "$NODE")")
NODE=$(xml "$NODE")
TARGET="gui/$(id -u)/$LABEL"

# bootout returns before the agent is gone, and bootstrapping a label that is still loaded fails.
launchctl bootout "$TARGET" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$TARGET" >/dev/null 2>&1 || break
  sleep 0.5
done
if [ "${1:-}" = remove ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

mkdir -p "$DIR/data" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/collect.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODE_DIR:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/data/collect.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/collect.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: daily at 09:00, log in $DIR/data/collect.log"
