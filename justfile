port := env("PORT", "4317")

# refresh the data, then serve and open the dashboard; a failed refresh still serves the stored data
dash: _deps
    -node collect.mjs
    PORT={{port}} node serve.mjs

# serve the dashboard on localhost (next free port if taken) and open it; ctrl-c stops the server
serve:
    PORT={{port}} node serve.mjs

# serve the dashboard in the background and open it; the server survives closing the terminal, not logout
start:
    @mkdir -p data
    @PORT={{port}} nohup node "{{justfile_directory()}}/serve.mjs" >> data/serve.log 2>&1 &
    @echo "log in data/serve.log; just stop stops the server"

# stop the server that just start started
stop:
    @pkill -f "{{justfile_directory()}}/serve.mjs" && echo stopped || echo "not running"

# snapshot the current usage into data/
collect: _deps
    node collect.mjs

# collect daily at 09:00 and at login (launchd agent local.claude-usage)
schedule:
    ./schedule.sh

# remove the launchd agent
unschedule:
    ./schedule.sh remove

# the last collector runs of the launchd agent
log:
    tail -n 20 data/collect.log

_deps:
    @test -x node_modules/.bin/ccusage || npm ci
