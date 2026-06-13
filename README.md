# Web Terminal

A simple, phone-friendly web-based terminal inspired by [ttyd](https://github.com/tsl0922/ttyd).

- Open multiple bash terminals in browser tabs
- Phone-optimized control bar with arrow keys, Ctrl+C/Z/D, Tab, Enter
- Quick command buttons: `clear`, `ls`, `list` (runs `ls -la`)
- Real PTY using Python + WebSockets + xterm.js

## Run

```bash
# 1. Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start server
python3 server.py
```

Open `http://<your-ip>:8765` in any browser (desktop or phone).

## Project Structure

```
.
├── server.py          # WebSocket server + static file serving
├── requirements.txt   # Python dependencies
├── README.md
└── static/
    ├── index.html     # Terminal page
    ├── app.js         # Tabs, xterm.js, control buttons
    └── style.css      # Phone-friendly layout
```

## Screenshots

Phone viewport

![Phone layout](demo-phone.png)

Desktop viewport

![Desktop layout](demo-desktop.png)

## Notes

- No authentication: only run on trusted networks.
- HTTPS/WSS not included; put behind nginx or a reverse proxy for remote/production use.
- Each tab starts a fresh `/bin/bash` process.
