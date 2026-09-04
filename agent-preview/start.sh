#!/bin/sh
# Combined entrypoint for the temporary cloud preview service.
#
# Runs the zero-dependency device simulator (fake DirecTV/Roku/Samsung gear
# on 127.0.0.1, offset ports) as a background process, then runs the real
# on-site agent in the foreground. Because both processes share this one
# container, the agent reaches the simulated devices over localhost exactly
# as it would reach real gear over a bar's LAN -- nothing in agent code
# needed to change.
#
# Render supplies $PORT; the agent (agent/config.js) already reads that, so
# it's picked up automatically -- do not set PORT yourself in the service's
# env vars.
set -e
node simulator/simulator.js --mode ports --quiet &
SIM_PID=$!
trap "kill $SIM_PID 2>/dev/null" EXIT
node agent/server.js
