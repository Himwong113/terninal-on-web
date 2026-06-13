"""End-to-end test for the web terminal.

Run with: source .venv/bin/activate && python3 test_e2e.py
"""
import asyncio
import re
import socket
import subprocess
import sys
import time

import aiohttp


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def wait_for_server(port, max_wait=10):
    start = time.time()
    while time.time() - start < max_wait:
        try:
            import urllib.request

            urllib.request.urlopen(f"http://127.0.0.1:{port}", timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


async def run_tests(port, read_only):
    base = f"http://127.0.0.1:{port}"
    jar = aiohttp.CookieJar(unsafe=True)

    env = {**__import__("os").environ, "TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}
    proc = subprocess.Popen(
        ["python3", "-u", "server.py", "--port", str(port)]
        + (["--read-only"] if read_only else []),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )

    try:
        if not wait_for_server(port):
            print(proc.stdout.read())
            raise AssertionError("Server did not start")

        async with aiohttp.ClientSession(cookie_jar=jar) as session:
            async with session.get(f"{base}/") as resp:
                assert resp.status == 200, f"index status {resp.status}"
                print("[OK] static index loads")

            async with session.get(f"{base}/auth-check") as resp:
                data = await resp.json()
                assert data["authenticated"] is False
                print("[OK] not authenticated before login")

            async with session.post(
                f"{base}/api/login",
                json={"username": "admin", "password": "change-me"},
            ) as resp:
                data = await resp.json()
                assert data["success"] is True
                print("[OK] login succeeds")

            # Read OTP from server output
            otp = None
            deadline = time.time() + 5
            loop = asyncio.get_event_loop()
            while time.time() < deadline:
                try:
                    line = await asyncio.wait_for(
                        loop.run_in_executor(None, proc.stdout.readline),
                        timeout=0.5,
                    )
                except asyncio.TimeoutError:
                    continue
                if not line:
                    continue
                print("server:", line.strip())
                m = re.search(r"Code for login: (\d{6})", line)
                if m:
                    otp = m.group(1)
                    break

            assert otp is not None, "OTP not found in server output"
            print(f"[OK] OTP received: {otp}")

            async with session.post(
                f"{base}/api/verify-otp",
                json={"username": "admin", "otp": otp},
            ) as resp:
                data = await resp.json()
                assert data["success"] is True
                assert data["read_only"] is read_only
                print("[OK] OTP verified (read_only=%s)" % read_only)

            async with session.get(f"{base}/auth-check") as resp:
                data = await resp.json()
                assert data["authenticated"] is True
                assert data["username"] == "admin"
                assert data["read_only"] is read_only
                print("[OK] authenticated after OTP")

            async with session.ws_connect(f"{base}/ws") as ws:
                await ws.send_bytes(b"echo hello-from-terminal\r")
                msg = await ws.receive(timeout=3)
                assert msg.type == aiohttp.WSMsgType.BINARY
                print("[OK] websocket received data")
                await ws.close()

            async with aiohttp.ClientSession() as session2:
                async with session2.post(
                    f"{base}/api/login",
                    json={"username": "admin", "password": "wrong"},
                ) as resp:
                    assert resp.status == 401
                    print("[OK] wrong password rejected")

            async with aiohttp.ClientSession() as session3:
                try:
                    async with session3.ws_connect(f"{base}/ws") as ws:
                        raise AssertionError("websocket without cookie connected")
                except Exception:
                    print("[OK] websocket without cookie rejected")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def main():
    print("\n--- Writable mode tests ---")
    asyncio.run(run_tests(find_free_port(), read_only=False))

    print("\n--- Read-only mode tests ---")
    asyncio.run(run_tests(find_free_port(), read_only=True))

    print("\nAll tests passed!")


if __name__ == "__main__":
    main()
