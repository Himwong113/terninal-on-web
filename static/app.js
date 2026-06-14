const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws`;

let tabCounter = 0;
let activeTabId = null;
let currentUser = null;
let readOnlyMode = false;
let shiftState = 0; // 0=off, 1=one-shot, 2=caps-lock
let lastShiftTap = 0;
let termFontSize = parseInt(localStorage.getItem('termFontSize') || '14');
const tabs = new Map();

const keyMap = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  tab: '\t',
  enter: '\r',
  'ctrl-c': '\x03',
  'ctrl-z': '\x1a',
  'ctrl-d': '\x04',
  backspace: '\x7f',
};

const cmdMap = {
  clear: 'clear',
  ls: 'ls',
  'cd ..': 'cd ..',
};

const shiftMap = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '_': '-',
  '.': '>', '>': '.',
  '/': '?', '?': '/',
  '@': '~', '~': '@',
  ' ': ' ',
};

function applyShift(char) {
  if (char >= 'a' && char <= 'z') {
    return char.toUpperCase();
  }
  if (shiftMap[char] !== undefined) {
    return shiftMap[char];
  }
  return char.toUpperCase();
}

function encode(str) {
  return new TextEncoder().encode(str);
}

function updateShiftBtn() {
  const btn = document.querySelector('[data-key="shift"]');
  if (!btn) return;
  btn.classList.toggle('shift-one-shot', shiftState === 1);
  btn.classList.toggle('shift-caps', shiftState === 2);
}

// ---------------------------------------------------------------------------
// Auth UI
// ---------------------------------------------------------------------------

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const otpForm = document.getElementById('otp-form');
const loginError = document.getElementById('login-error');
const otpError = document.getElementById('otp-error');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const otpInput = document.getElementById('otp');
const readonlyBadge = document.getElementById('readonly-badge');

let pendingUsername = '';

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function checkAuth() {
  const res = await fetch('/auth-check');
  const data = await res.json();
  if (data.authenticated) {
    currentUser = data.username;
    readOnlyMode = data.read_only;
    hideLogin();
    initApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginOverlay.classList.remove('hidden');
  loginForm.classList.remove('hidden');
  otpForm.classList.add('hidden');
  usernameInput.focus();
}

function showOtp() {
  loginForm.classList.add('hidden');
  otpForm.classList.remove('hidden');
  otpInput.value = '';
  otpInput.focus();
}

function hideLogin() {
  loginOverlay.classList.add('hidden');
  if (readOnlyMode) {
    readonlyBadge.classList.remove('hidden');
  } else {
    readonlyBadge.classList.add('hidden');
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  pendingUsername = usernameInput.value.trim();
  const { ok, data } = await apiPost('/api/login', {
    username: pendingUsername,
    password: passwordInput.value,
  });
  if (ok) {
    showOtp();
  } else {
    loginError.textContent = data.error || 'Login failed';
  }
});

otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  otpError.textContent = '';
  const { ok, data } = await apiPost('/api/verify-otp', {
    username: pendingUsername,
    otp: otpInput.value.trim(),
  });
  if (ok) {
    readOnlyMode = data.read_only;
    hideLogin();
    initApp();
  } else {
    otpError.textContent = data.error || 'OTP verification failed';
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  await apiPost('/api/logout', {});
  location.reload();
});

// ---------------------------------------------------------------------------
// Terminal logic
// ---------------------------------------------------------------------------

function createTerminal() {
  const id = ++tabCounter;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: termFontSize,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const termEl = document.createElement('div');
  termEl.className = 'terminal-container';
  termEl.id = `term-${id}`;
  document.getElementById('terminals').appendChild(termEl);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = id;
  tabEl.innerHTML = `<span class="tab-title">Tab ${id}</span><span class="close" title="Close">×</span>`;
  document.getElementById('tab-bar').insertBefore(tabEl, document.getElementById('new-tab'));

  term.open(termEl);

  term.onTitleChange((title) => {
    tabEl.querySelector('.tab-title').textContent = title || `Tab ${id}`;
  });

  // intentionalClose = true when user explicitly closes the tab (X button)
  let intentionalClose = false;
  let reconnectTimer = null;

  function connectSocket() {
    const socket = new WebSocket(`${wsUrl}?tab=${id}`);
    socket.binaryType = 'arraybuffer';

    const t = tabs.get(id);
    if (t) t.socket = socket;

    socket.onopen = () => {
      // Clear any reconnecting message on reconnect
      if (t && t.reconnecting) {
        term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
        t.reconnecting = false;
      }
      resize();
    };

    socket.onmessage = (event) => {
      const data = new Uint8Array(event.data);
      term.write(data);
    };

    socket.onclose = () => {
      if (intentionalClose) return;
      const entry = tabs.get(id);
      if (!entry) return; // tab already removed
      entry.reconnecting = true;
      term.write('\r\n\x1b[33m[Disconnected — reconnecting in 2s...]\x1b[0m\r\n');
      reconnectTimer = setTimeout(() => {
        if (!intentionalClose && tabs.has(id)) {
          connectSocket();
        }
      }, 2000);
    };

    socket.onerror = (err) => {
      console.error(err);
    };

    return socket;
  }

  function resize() {
    fitAddon.fit();
    const t = tabs.get(id);
    if (t && t.socket && t.socket.readyState === WebSocket.OPEN) {
      t.socket.send(JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }));
    }
  }

  term.onData((data) => {
    if (readOnlyMode) return;
    const t = tabs.get(id);
    if (t && t.socket && t.socket.readyState === WebSocket.OPEN) {
      t.socket.send(encode(data));
    }
  });

  term.onResize(resize);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) {
      closeTab(id);
    } else {
      switchTab(id);
    }
  });

  const socket = connectSocket();
  tabs.set(id, { term, socket, element: termEl, tabEl, fitAddon, reconnecting: false, connectSocket, intentionalCloseRef: () => intentionalClose, stopReconnect: () => { intentionalClose = true; clearTimeout(reconnectTimer); } });
  switchTab(id);
  setTimeout(resize, 0);

  return id;
}

function switchTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  for (const [tid, t] of tabs) {
    const active = tid === id;
    t.element.classList.toggle('active', active);
    t.tabEl.classList.toggle('active', active);
  }
  const t = tabs.get(id);
  setTimeout(() => {
    t.fitAddon.fit();
  }, 0);
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  // Stop auto-reconnect and signal server to kill tmux session
  if (t.stopReconnect) t.stopReconnect();
  try {
    if (t.socket && t.socket.readyState === WebSocket.OPEN) {
      t.socket.send(JSON.stringify({ type: 'close' }));
    }
    t.socket.close();
  } catch (e) {
    // ignore
  }
  t.term.dispose();
  t.element.remove();
  t.tabEl.remove();
  tabs.delete(id);

  const remaining = Array.from(tabs.keys());
  if (activeTabId === id) {
    if (remaining.length) {
      switchTab(remaining[0]);
    } else {
      activeTabId = null;
    }
  }
}

function initApp() {
  // Set font size selector to saved value
  const fontSel = document.getElementById('font-size-select');
  if (fontSel) {
    fontSel.value = String(termFontSize);
    fontSel.addEventListener('change', () => {
      termFontSize = parseInt(fontSel.value);
      localStorage.setItem('termFontSize', termFontSize);
      for (const t of tabs.values()) {
        t.term.options.fontSize = termFontSize;
        t.fitAddon.fit();
      }
    });
  }

  // Floating scroll buttons — send tmux copy-mode scroll via WS
  document.getElementById('scroll-up').addEventListener('click', () => {
    const t = tabs.get(activeTabId);
    if (t && t.socket && t.socket.readyState === WebSocket.OPEN) {
      t.socket.send(JSON.stringify({ type: 'scroll', direction: 'up' }));
    }
  });
  document.getElementById('scroll-down').addEventListener('click', () => {
    const t = tabs.get(activeTabId);
    if (t && t.socket && t.socket.readyState === WebSocket.OPEN) {
      t.socket.send(JSON.stringify({ type: 'scroll', direction: 'down' }));
    }
  });

  document.getElementById('new-tab').addEventListener('click', createTerminal);

  // Section toggles
  document.getElementById('controls').addEventListener('click', (e) => {
    if (!e.target.matches('button')) return;

    // Fold / unfold sections
    if (e.target.classList.contains('section-toggle')) {
      const section = e.target.dataset.section;
      const content = document.getElementById(`section-${section}`);
      const isCollapsed = content.classList.toggle('collapsed');
      e.target.textContent = `${isCollapsed ? '▶' : '▼'} ${section.charAt(0).toUpperCase() + section.slice(1)}`;
      return;
    }

    if (e.target.dataset.key === 'shift') {
      const now = Date.now();
      if (shiftState === 0) {
        shiftState = 1; // off → one-shot
      } else if (shiftState === 1 && now - lastShiftTap < 500) {
        shiftState = 2; // double-tap → caps-lock
      } else if (shiftState === 1) {
        shiftState = 0; // tap again → off
      } else {
        shiftState = 0; // caps-lock tap → off
      }
      lastShiftTap = now;
      updateShiftBtn();
      return;
    }

    if (e.target.dataset.key === 'kb-symbols') {
      document.getElementById('kb-letters').classList.add('kb-panel-hidden');
      document.getElementById('kb-symbols').classList.remove('kb-panel-hidden');
      return;
    }
    if (e.target.dataset.key === 'kb-letters') {
      document.getElementById('kb-symbols').classList.add('kb-panel-hidden');
      document.getElementById('kb-letters').classList.remove('kb-panel-hidden');
      return;
    }

    const t = tabs.get(activeTabId);
    if (!t || t.socket.readyState !== WebSocket.OPEN) return;

    if (readOnlyMode) return;

    const key = e.target.dataset.key;
    const cmd = e.target.dataset.cmd;
    const char = e.target.dataset.char;

    if (key && keyMap[key]) {
      t.socket.send(encode(keyMap[key]));
    } else if (cmd && cmdMap[cmd]) {
      t.socket.send(encode(cmdMap[cmd] + '\r'));
    } else if (char !== undefined) {
      const sendChar = shiftState > 0 ? applyShift(char) : char;
      t.socket.send(encode(sendChar));
      if (shiftState === 1) {
        // one-shot: reset after one char
        shiftState = 0;
        updateShiftBtn();
      }
    }
    // Keep the native phone keyboard hidden after using on-screen buttons
    t.term.blur();
  });

  // Refit all terminals when the terminal wrapper resizes
  // (e.g. when Controls / Keyboard sections fold/unfold)
  const wrapper = document.getElementById('terminal-wrapper');
  if (wrapper && typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      for (const t of tabs.values()) {
        t.fitAddon.fit();
        t.term.scrollToBottom();
      }
    });
    resizeObserver.observe(wrapper);
  }

  // Reconnect all tabs when page becomes visible again (e.g. after lock screen)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const [id, t] of tabs) {
      if (!t.intentionalCloseRef || t.intentionalCloseRef()) continue;
      const state = t.socket ? t.socket.readyState : WebSocket.CLOSED;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
        // connectSocket is closed over inside createTerminal; trigger via reconnect mechanism
        // Re-create socket by dispatching a synthetic close event won't work — instead
        // we store connectSocket on the tab entry and call it directly
        if (t.connectSocket) {
          t.connectSocket();
        }
      }
    }
  });

  // Font size selector
  const fontSelect = document.getElementById('font-size-select');
  if (fontSelect) {
    // Set initial value
    fontSelect.value = String(termFontSize);
    fontSelect.addEventListener('change', () => {
      termFontSize = parseInt(fontSelect.value);
      localStorage.setItem('termFontSize', termFontSize);
      for (const t of tabs.values()) {
        t.term.options.fontSize = termFontSize;
        t.fitAddon.fit();
      }
    });
  }

  createTerminal();
}

// Start by checking auth
checkAuth();
