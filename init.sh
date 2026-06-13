#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required"; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux is required"; exit 1; }
command -v ufw >/dev/null 2>&1 || { echo "ERROR: ufw is required"; exit 1; }

# ---------------------------------------------------------------------------
# Create config templates if missing
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example. Please edit it and run again."
    exit 1
fi

if [ ! -f .conf ]; then
    cp .conf.example .conf
    echo "Created .conf from .conf.example. Please edit it and run again."
    exit 1
fi

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
set -a
source .env
set +a

PORT="${PORT_OVERRIDE:-${PORT:-8765}}"
READ_ONLY="${READ_ONLY:-false}"

# ---------------------------------------------------------------------------
# Helper actions and optional port override
# ---------------------------------------------------------------------------
# Usage: ./init.sh [start|stop|restart|attach|status] [PORT]
#        ./init.sh 8080          # start on port 8080
#        ./init.sh start 8080    # same as above

ACTION="${1:-start}"
PORT_OVERRIDE=""

# If first arg is a number, treat it as port and default action to start
if [[ "$ACTION" =~ ^[0-9]+$ ]]; then
    PORT_OVERRIDE="$ACTION"
    ACTION="start"
fi

# If second arg is a number, treat it as port override
if [[ "${2:-}" =~ ^[0-9]+$ ]]; then
    PORT_OVERRIDE="$2"
fi

case "$ACTION" in
    stop)
        if tmux has-session -t webterminal 2>/dev/null; then
            tmux kill-session -t webterminal
            echo "Stopped webterminal tmux session."
        else
            echo "No webterminal tmux session running."
        fi
        exit 0
        ;;

    restart)
        "$0" stop || true
        ;;

    attach)
        tmux attach -t webterminal
        exit 0
        ;;

    status)
        if tmux has-session -t webterminal 2>/dev/null; then
            echo "webterminal is running."
            tmux list-sessions -F '#{session_name}: #{session_created}' | grep webterminal
        else
            echo "webterminal is not running."
        fi
        exit 0
        ;;

    start|*)
        ;;
esac

# ---------------------------------------------------------------------------
# Virtual environment
# ---------------------------------------------------------------------------
if [ ! -d .venv ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
fi

if [ ! -f .venv/bin/activate ]; then
    echo "ERROR: .venv is not a valid virtual environment"
    exit 1
fi

# ---------------------------------------------------------------------------
# Install / update dependencies
# ---------------------------------------------------------------------------
echo "Installing dependencies..."
source .venv/bin/activate
pip install -q -r requirements.txt

# ---------------------------------------------------------------------------
# Open UFW port
# ---------------------------------------------------------------------------
echo "Opening UFW port $PORT/tcp..."
sudo ufw allow "${PORT}/tcp" comment 'web-terminal' >/dev/null

# ---------------------------------------------------------------------------
# Start server in tmux
# ---------------------------------------------------------------------------
if tmux has-session -t webterminal 2>/dev/null; then
    echo "Restarting existing webterminal tmux session..."
    tmux kill-session -t webterminal
fi

TMUX_CMD="source .venv/bin/activate && python3 server.py --port $PORT"
if [ "$READ_ONLY" = "true" ]; then
    TMUX_CMD="${TMUX_CMD} --read-only"
fi

echo "Starting webterminal tmux session on port $PORT..."
tmux new-session -d -s webterminal "$TMUX_CMD"

echo ""
echo "✅ Web Terminal is running in tmux session 'webterminal'"
echo "   URL: http://$(hostname -I | awk '{print $1}'):$PORT"
echo "   Attach: ./init.sh attach"
echo "   Stop:   ./init.sh stop"
echo "   Status: ./init.sh status"
