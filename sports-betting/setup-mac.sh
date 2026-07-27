#!/bin/sh
# One-time macOS scheduling setup.
#
# Installs a launchd agent that runs `bet.py daily` every 20 minutes.
# Unlike cron, launchd fires a missed timer THE MOMENT the Mac wakes, and
# the job wraps itself in caffeinate so the machine stays awake through
# the run. Pair it with the pmset auto-wake printed at the end and the
# daily run happens even if the laptop stays closed all day (plugged in).
set -e

APPDIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.sportsbook.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd "$APPDIR" &amp;&amp; /usr/bin/caffeinate -im python3 bet.py daily >> run.log 2>&amp;1</string>
  </array>
  <key>StartInterval</key><integer>1200</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# (re)load the agent
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || \
    launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || \
    launchctl load "$PLIST"
echo "launchd agent installed: $PLIST"
launchctl list | grep "$LABEL" || true

# the old cron entry would just double-log (runs stay idempotent either
# way); one scheduler is cleaner
if crontab -l 2>/dev/null | grep -q "bet.py daily"; then
    crontab -l | grep -v "bet.py daily" \
        | grep -v '^CRON_TZ=America/Los_Angeles$' | crontab -
    echo "removed the old cron entry"
fi

cat <<'MSG'

Recommended: schedule a daily auto-wake AFTER the 9:30 gate, so the
on-wake launchd tick runs immediately (needs your password):

    sudo pmset repeat cancel
    sudo pmset repeat wakeorpoweron MTWRFSU 09:32:00

Notes: scheduled wakes are reliable when plugged in; on battery with the
lid closed macOS may skip them. Verify anytime with: pmset -g sched
MSG
