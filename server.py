import asyncio
import fcntl
import http
import json
import os
import pathlib
import pty
import signal
import struct
import termios

import websockets

STATIC_DIR = (pathlib.Path(__file__).parent / "static").resolve()


def set_winsize(fd, cols, rows):
    """Set the pseudo-terminal window size."""
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def serve_static(path):
    """Serve a file from the static directory."""
    path = path.split("?", 1)[0]
    if path == "/":
        path = "/index.html"
    try:
        file_path = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(STATIC_DIR)):
            return (403, {}, b"Forbidden")
        content_type = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
        }.get(file_path.suffix, "application/octet-stream")
        headers = {
            "Content-Type": content_type,
            "Cache-Control": "no-cache, no-store, must-revalidate",
        }
        return (http.HTTPStatus.OK, headers, file_path.read_bytes())
    except FileNotFoundError:
        return (http.HTTPStatus.NOT_FOUND, {}, b"Not found")


async def process_request(path, request_headers):
    """Handle plain HTTP requests for static files; pass through WebSocket upgrades."""
    if request_headers.get("Upgrade", "").lower() == "websocket":
        return None
    return serve_static(path)


async def terminal_handler(websocket, path):
    """Spawn a bash PTY and bridge it to a WebSocket."""
    cols, rows = 80, 24
    pid, fd = pty.fork()

    if pid == 0:
        # Child process: become an interactive bash shell.
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        os.execvpe("/bin/bash", ["/bin/bash"], env)

    # Parent process: bridge PTY <-> WebSocket.
    set_winsize(fd, cols, rows)
    loop = asyncio.get_event_loop()

    async def pty_to_ws():
        while True:
            try:
                data = await loop.run_in_executor(None, os.read, fd, 4096)
                if not data:
                    break
                await websocket.send(data)
            except Exception:
                break
        try:
            await websocket.close()
        except Exception:
            pass

    task = asyncio.create_task(pty_to_ws())

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                await loop.run_in_executor(None, os.write, fd, message)
            else:
                msg = json.loads(message)
                if msg.get("type") == "resize":
                    set_winsize(fd, msg["cols"], msg["rows"])
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


async def main():
    async with websockets.serve(
        terminal_handler, "0.0.0.0", 8765, process_request=process_request
    ):
        print("Server running on http://0.0.0.0:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
