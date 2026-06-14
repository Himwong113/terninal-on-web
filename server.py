import argparse
import asyncio
import fcntl
import json
import os
import pathlib
import pty
import secrets
import signal
import struct
import sys
import termios
import time

import aiohttp
from aiohttp import web
from dotenv import load_dotenv
from telegram import Bot

# Load environment variables from .env
load_dotenv()

BASE_DIR = pathlib.Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
CONF_PATH = BASE_DIR / ".conf"

PORT = int(os.getenv("PORT", "8765"))
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
READ_ONLY_ENV = os.getenv("READ_ONLY", "false").lower() == "true"

SESSION_TTL = 3600
OTP_TTL = 300

sessions = {}  # token -> {"username": str, "expires": float, "read_only": bool}
otps = {}      # username -> {"code": str, "expires": float}

bot = Bot(token=TELEGRAM_BOT_TOKEN) if TELEGRAM_BOT_TOKEN else None


def load_accounts():
    if not CONF_PATH.exists():
        print(f"ERROR: {CONF_PATH} not found. Create it from .conf.example.", file=sys.stderr)
        sys.exit(1)
    with open(CONF_PATH, "r") as f:
        data = json.load(f)
    accounts = {}
    for entry in data.get("accounts", []):
        accounts[entry["username"]] = entry["password"]
    return accounts


def set_winsize(fd, cols, rows):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def generate_token():
    return secrets.token_urlsafe(32)


def generate_otp():
    return f"{secrets.randbelow(1000000):06d}"


def cleanup_expired():
    now = time.time()
    for token in list(sessions.keys()):
        if sessions[token]["expires"] < now:
            del sessions[token]
    for username in list(otps.keys()):
        if otps[username]["expires"] < now:
            del otps[username]


async def send_otp(code, chat_id):
    """Send OTP via Telegram. Falls back to console if bot is not configured."""
    if bot and chat_id:
        try:
            await asyncio.wait_for(
                bot.send_message(
                    chat_id=int(chat_id),
                    text=f"🔐 Web Terminal OTP: {code}",#\nValid for 5 minutes.",
                ),
                timeout=10,
            )
            return True
        except Exception as e:
            print(f"Failed to send Telegram OTP: {e}", file=sys.stderr, flush=True)
    print(f"[OTP FALLBACK] Code for login: {code}", flush=True)
    return True


# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------

async def index(request):
    return web.FileResponse(STATIC_DIR / "index.html")


async def auth_check(request):
    cleanup_expired()
    token = request.cookies.get("session")
    session = sessions.get(token)
    if not session or session["expires"] < time.time():
        return web.json_response({"authenticated": False})
    return web.json_response({
        "authenticated": True,
        "username": session["username"],
        "read_only": session["read_only"],
    })


async def login(request):
    cleanup_expired()
    accounts = load_accounts()

    try:
        data = await request.json()
        username = data.get("username", "")
        password = data.get("password", "")
    except Exception:
        return web.json_response({"success": False, "error": "Invalid request"}, status=400)

    if username not in accounts or accounts[username] != password:
        return web.json_response({"success": False, "error": "Invalid credentials"}, status=401)

    code = generate_otp()
    otps[username] = {"code": code, "expires": time.time() + OTP_TTL}

    if not await send_otp(code, TELEGRAM_CHAT_ID):
        return web.json_response({"success": False, "error": "Failed to send OTP"}, status=500)

    return web.json_response({"success": True})


async def verify_otp(request):
    cleanup_expired()

    try:
        data = await request.json()
        username = data.get("username", "")
        code = data.get("otp", "")
    except Exception:
        return web.json_response({"success": False, "error": "Invalid request"}, status=400)

    entry = otps.get(username)
    if not entry or entry["code"] != code or entry["expires"] < time.time():
        return web.json_response({"success": False, "error": "Invalid or expired OTP"}, status=401)

    del otps[username]
    token = generate_token()
    read_only = request.app["read_only"]
    sessions[token] = {
        "username": username,
        "expires": time.time() + SESSION_TTL,
        "read_only": read_only,
    }

    response = web.json_response({"success": True, "read_only": read_only})
    response.set_cookie("session", token, httponly=True, samesite="Lax", max_age=SESSION_TTL)
    return response


async def logout(request):
    token = request.cookies.get("session")
    sessions.pop(token, None)
    response = web.json_response({"success": True})
    response.del_cookie("session")
    return response


# ---------------------------------------------------------------------------
# WebSocket terminal handler
# ---------------------------------------------------------------------------

async def terminal_ws(request):
    cleanup_expired()
    token = request.cookies.get("session")
    session = sessions.get(token)
    if not session or session["expires"] < time.time():
        raise web.HTTPForbidden()

    read_only = session["read_only"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    cols, rows = 80, 24
    pid, fd = pty.fork()

    if pid == 0:
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        os.execvpe("/bin/bash", ["/bin/bash"], env)

    set_winsize(fd, cols, rows)
    loop = asyncio.get_event_loop()

    async def pty_to_ws():
        while True:
            try:
                data = await loop.run_in_executor(None, os.read, fd, 4096)
                if not data:
                    break
                await ws.send_bytes(data)
            except Exception:
                break
        if not ws.closed:
            await ws.close()

    task = asyncio.create_task(pty_to_ws())

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                if not read_only:
                    await loop.run_in_executor(None, os.write, fd, msg.data)
            elif msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    if data.get("type") == "resize":
                        set_winsize(fd, data["cols"], data["rows"])
                except json.JSONDecodeError:
                    pass
    finally:
        task.cancel()
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    return ws


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    parser = argparse.ArgumentParser(description="Web-based terminal server")
    parser.add_argument("--read-only", action="store_true", help="Run terminal in read-only mode")
    parser.add_argument("--port", type=int, default=PORT, help="Port to listen on (overrides .env)")
    args = parser.parse_args()

    port = args.port
    read_only = READ_ONLY_ENV or args.read_only

    # Pre-load accounts to fail fast on bad config
    load_accounts()

    app = web.Application()
    app["read_only"] = read_only

    app.router.add_get("/", index)
    app.router.add_get("/auth-check", auth_check)
    app.router.add_post("/api/login", login)
    app.router.add_post("/api/verify-otp", verify_otp)
    app.router.add_post("/api/logout", logout)
    app.router.add_get("/ws", terminal_ws)
    app.router.add_static("/", STATIC_DIR)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    print(f"Server running on http://0.0.0.0:{port} (read_only={read_only})", flush=True)
    await site.start()

    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    try:
        await stop_event.wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
