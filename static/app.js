const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;

let tabCounter = 0;
let activeTabId = null;
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
};

const cmdMap = {
  clear: 'clear',
  ls: 'ls',
  list: 'ls -la',
};

function encode(str) {
  return new TextEncoder().encode(str);
}

function createTerminal() {
  const id = ++tabCounter;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';

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

  function resize() {
    fitAddon.fit();
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }));
    }
  }

  socket.onopen = () => {
    resize();
  };

  socket.onmessage = (event) => {
    const data = new Uint8Array(event.data);
    term.write(data);
  };

  socket.onclose = () => {
    term.write('\r\n[Disconnected]\r\n');
  };

  socket.onerror = (err) => {
    term.write('\r\n[Connection error]\r\n');
    console.error(err);
  };

  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encode(data));
    }
  });

  term.onResize(resize);
  window.addEventListener('resize', resize);
  // Also fit when orientation changes on phones.
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) {
      closeTab(id);
    } else {
      switchTab(id);
    }
  });

  tabs.set(id, { term, socket, element: termEl, tabEl, fitAddon });
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
    t.term.focus();
  }, 0);
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  try {
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

document.getElementById('new-tab').addEventListener('click', createTerminal);

document.getElementById('controls').addEventListener('click', (e) => {
  if (!e.target.matches('button')) return;
  const t = tabs.get(activeTabId);
  if (!t || t.socket.readyState !== WebSocket.OPEN) return;

  const key = e.target.dataset.key;
  const cmd = e.target.dataset.cmd;

  if (key && keyMap[key]) {
    t.socket.send(encode(keyMap[key]));
    t.term.focus();
  } else if (cmd && cmdMap[cmd]) {
    t.socket.send(encode(cmdMap[cmd] + '\r'));
    t.term.focus();
  }
});

// Initialize first terminal.
createTerminal();
