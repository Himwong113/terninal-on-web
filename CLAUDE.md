# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run (manual)
python3 server.py
python3 server.py --port 8080
python3 server.py --read-only

# Run (tmux + UFW)
./init.sh
./init.sh 8080
./init.sh stop

# Tests (requires .conf with admin:change-me account)
source .venv/bin/activate && python3 test_e2e.py
```

## Configuration

Two config files required before running:

`.env` — server settings (copy from `.env.example`):
- `PORT` — default 8765
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — OTP delivery; if unset, OTP prints to console
- `READ_ONLY` — server-wide read-only mode

`.conf` — accounts JSON (copy from `.conf.example`):
```json
{"accounts": [{"username": "admin", "password": "change-me"}]}
```
Loaded fresh on every login request — no restart needed for account changes.

## Architecture

Single file backend: `server.py` (aiohttp + PTY + auth). Static frontend: `static/` (vanilla JS, no build step).

**Auth flow** (two-factor):
1. `POST /api/login` — validates username/password against `.conf`, generates 6-digit OTP, sends via Telegram bot (or prints to console as fallback)
2. `POST /api/verify-otp` — validates OTP, issues `session` httponly cookie (1hr TTL)
3. Sessions stored in in-memory dicts (`sessions`, `otps`) — lost on restart

**Terminal flow** (`GET /ws?tab=<id>`):
- Validates session cookie
- `pty.fork()` — child `execvpe`s into tmux: attaches existing session `web-{username}-{tabid}` or creates new one
- Parent proxies bytes: PTY → WS (raw binary), WS → PTY (blocked in read-only mode)
- JSON text frames handle `resize` (TIOCSWINSZ) and `close` (kills tmux session + SIGTERM child)
- Each browser tab gets its own tmux session; closing tab kills it; reconnecting reattaches

**Read-only mode**: set at server startup (env or `--read-only` flag), stored in `app["read_only"]` and per-session. Server silently drops binary WS input — frontend still shows terminal output.

**Tab ID sanitization**: `tab` query param stripped to `[a-z0-9]`, max 16 chars, to form safe tmux session names.

## Testing

`test_e2e.py` starts a real server subprocess on a free port with Telegram disabled, reads OTP from stdout, exercises the full auth flow and WebSocket connection in both writable and read-only modes. Requires `.conf` to contain `admin:change-me`.
