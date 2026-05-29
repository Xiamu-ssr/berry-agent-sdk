// ============================================================
// @berry-agent/a8s-server — Built-in operator UI
// ============================================================
//
// Single-page HTML the a8s server emits on GET /ui. Pure HTML + CSS +
// inline JS so there's no build step, no bundler, no extra runtime
// dependency. The page calls the operator API directly using an admin
// token the operator pastes once (stored in localStorage).
//
// Views (one always visible at a time, tab nav):
//   - Cluster   : aggregate counts from /v1/operator/cluster
//   - Workers   : /v1/operator/workers, with drain/undrain/evict actions
//   - Agents    : /v1/agents (assignments) + click to drill into sessions
//   - Admin     : chat with the berry-admin agent via /v1/agents/.../send
//
// Design constraints (deliberate):
//   - Zero external CDN. Every byte ships with a8s.
//   - No framework. ~400 lines of vanilla JS keeps the surface tiny.
//   - Token in localStorage, never logged or echoed in the DOM.
//   - All fetches go through one helper that injects auth + parses errors.

export const A8S_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>berry-a8s</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#171717; --muted:#667085; --line:#d0d5dd; --panel:#f8fafc; --ok:#0f766e; --warn:#b45309; --bad:#b91c1c; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f14; --fg:#e5e7eb; --muted:#9ca3af; --line:#374151; --panel:#111827; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { padding:14px 22px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:18px; }
  header h1 { margin:0; font-size:18px; }
  header nav { display:flex; gap:6px; flex:1; }
  header button { background:none; border:1px solid transparent; padding:6px 12px; color:var(--muted); border-radius:6px; cursor:pointer; font:inherit; }
  header button:hover { color:var(--fg); background:var(--panel); }
  header button.active { color:var(--fg); border-color:var(--line); background:var(--panel); }
  header .right { color:var(--muted); font-size:12px; }
  main { padding:22px; max-width:1200px; margin:0 auto; }
  .view { display:none; }
  .view.active { display:block; }
  h2 { margin:0 0 14px; font-size:16px; }
  table { width:100%; border-collapse:collapse; margin:8px 0 18px; }
  th, td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:13px; }
  th { background:var(--panel); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }
  td.muted, .muted { color:var(--muted); }
  .row-actions button { font-size:12px; padding:4px 10px; margin-right:6px; border:1px solid var(--line); background:var(--bg); border-radius:5px; cursor:pointer; color:var(--fg); }
  .row-actions button:hover { background:var(--panel); }
  .row-actions button.danger { color:var(--bad); border-color:var(--bad); }
  .row-actions button.danger:hover { background:var(--bad); color:#fff; }
  .card-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:18px; }
  .card { padding:14px 16px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
  .card .label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.04em; }
  .card .value { font-size:24px; font-weight:600; margin-top:4px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:600; background:var(--panel); color:var(--muted); border:1px solid var(--line); }
  .pill.active { color:var(--ok); border-color:var(--ok); }
  .pill.draining { color:var(--warn); border-color:var(--warn); }
  .pill.evicted, .pill.withdrawn { color:var(--bad); border-color:var(--bad); }
  .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:14px; }
  .toolbar button { padding:6px 12px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); cursor:pointer; font:inherit; }
  .toolbar button:hover { background:var(--panel); }
  .toolbar .grow { flex:1; }
  .err { padding:10px 14px; border:1px solid var(--bad); background:rgba(185,28,28,0.07); color:var(--bad); border-radius:6px; margin-bottom:14px; white-space:pre-wrap; font-family:ui-monospace, monospace; font-size:12px; }
  .chat { display:flex; flex-direction:column; gap:10px; }
  .chat-stream { border:1px solid var(--line); border-radius:8px; padding:14px; height:480px; overflow-y:auto; background:var(--panel); display:flex; flex-direction:column; gap:12px; }
  .chat-msg { padding:10px 12px; border-radius:8px; max-width:80%; white-space:pre-wrap; word-wrap:break-word; }
  .chat-msg.user { align-self:flex-end; background:var(--accent); color:#fff; }
  .chat-msg.assistant { align-self:flex-start; background:var(--bg); border:1px solid var(--line); }
  .chat-msg.system { align-self:center; background:var(--panel); border:1px dashed var(--line); color:var(--muted); font-size:12px; font-style:italic; }
  .chat-input { display:flex; gap:8px; }
  .chat-input textarea { flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; resize:vertical; min-height:60px; }
  .chat-input button { padding:10px 18px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; cursor:pointer; font:inherit; }
  .chat-input button:disabled { opacity:0.5; cursor:not-allowed; }
  .modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:10; }
  .modal-card { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:22px; max-width:420px; width:92%; }
  .modal-card h3 { margin:0 0 8px; }
  .modal-card input { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:5px; background:var(--bg); color:var(--fg); font:inherit; margin:10px 0; }
  .modal-card button { padding:8px 16px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:5px; cursor:pointer; font:inherit; }
  code { font-family:ui-monospace, monospace; font-size:12px; background:var(--panel); padding:1px 5px; border-radius:3px; }
  .sessions-list { margin-top:12px; }
  .session-row { padding:10px 12px; border:1px solid var(--line); border-radius:6px; margin-bottom:6px; cursor:pointer; display:flex; justify-content:space-between; background:var(--bg); }
  .session-row:hover { background:var(--panel); }
  .session-row.selected { border-color:var(--accent); }
  .event-stream { border:1px solid var(--line); border-radius:8px; padding:12px; max-height:400px; overflow-y:auto; font-family:ui-monospace, monospace; font-size:11px; background:var(--panel); white-space:pre-wrap; }
  .event-row { padding:4px 0; border-bottom:1px dotted var(--line); }
  .event-row:last-child { border-bottom:none; }
  .event-row .type { color:var(--accent); }
</style>
</head>
<body>

<header>
  <h1>🍓 berry-a8s</h1>
  <nav>
    <button data-view="cluster" class="active">Cluster</button>
    <button data-view="workers">Workers</button>
    <button data-view="agents">Agents</button>
    <button data-view="admin">Admin Chat</button>
  </nav>
  <div class="right">
    <span id="version-line">…</span>
    &nbsp;·&nbsp;
    <button id="logout-btn" style="font-size:12px; padding:4px 8px;">Reset token</button>
  </div>
</header>

<main>
  <div id="err-banner"></div>

  <!-- ---------- Cluster ---------- -->
  <section class="view active" data-view="cluster">
    <div class="toolbar"><h2 style="margin:0;">Cluster overview</h2><div class="grow"></div><button id="cluster-refresh">Refresh</button></div>
    <div id="cluster-cards" class="card-grid"></div>
  </section>

  <!-- ---------- Workers ---------- -->
  <section class="view" data-view="workers">
    <div class="toolbar"><h2 style="margin:0;">Workers</h2><div class="grow"></div><button id="workers-refresh">Refresh</button><button id="workers-join">Generate join script</button></div>
    <div id="workers-table"></div>
  </section>

  <!-- ---------- Agents ---------- -->
  <section class="view" data-view="agents">
    <div class="toolbar"><h2 style="margin:0;">Agents</h2><div class="grow"></div><button id="agents-refresh">Refresh</button></div>
    <div id="agents-table"></div>
    <div id="sessions-container" style="display:none; margin-top:24px;">
      <h2 id="sessions-heading"></h2>
      <div id="sessions-list" class="sessions-list"></div>
      <div id="events-container" style="display:none; margin-top:18px;">
        <h2 id="events-heading"></h2>
        <div id="events-stream" class="event-stream"></div>
      </div>
    </div>
  </section>

  <!-- ---------- Admin Chat ---------- -->
  <section class="view" data-view="admin">
    <div class="toolbar"><h2 style="margin:0;">berry-admin</h2><div class="grow"></div><span class="muted">Chat with the cluster admin agent</span></div>
    <div class="chat">
      <div id="chat-stream" class="chat-stream"></div>
      <div class="chat-input">
        <textarea id="chat-prompt" placeholder="Ask the admin agent: 'how is the cluster?' / 'drain worker X' / 'how do I add a worker?'"></textarea>
        <button id="chat-send">Send</button>
      </div>
    </div>
  </section>
</main>

<script>
(() => {
  // ---------- Auth ----------
  const TOKEN_KEY = 'berryAdminToken';
  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function showTokenModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = \`
      <div class="modal-card">
        <h3>Admin token</h3>
        <p class="muted">This a8s requires a Bearer token. Paste the value the operator started a8s with (<code>--admin-token</code>).</p>
        <input type="password" id="modal-token-input" autocomplete="off" placeholder="Bearer token…">
        <button id="modal-token-save">Save</button>
      </div>\`;
    document.body.appendChild(modal);
    const input = modal.querySelector('#modal-token-input');
    input.focus();
    const save = () => {
      const v = input.value.trim();
      if (!v) return;
      setToken(v);
      modal.remove();
      refreshAll();
    };
    modal.querySelector('#modal-token-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  // ---------- API ----------
  async function api(path, opts) {
    const token = getToken();
    if (!token) { showTokenModal(); throw new Error('no token'); }
    const headers = Object.assign({ 'content-type': 'application/json' }, opts && opts.headers, {
      authorization: 'Bearer ' + token,
    });
    const resp = await fetch(path, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      clearToken();
      showTokenModal();
      throw new Error('unauthorized — token cleared');
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(\`HTTP \${resp.status}: \${text.slice(0, 200)}\`);
    }
    if (resp.headers.get('content-type')?.includes('json')) return resp.json();
    return resp.text();
  }

  function showError(err) {
    const banner = document.getElementById('err-banner');
    banner.innerHTML = '<div class="err">' + (err && err.message ? err.message : String(err)) + '</div>';
    setTimeout(() => { banner.innerHTML = ''; }, 6000);
  }

  // ---------- View routing ----------
  document.querySelectorAll('header nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view');
      document.querySelectorAll('header nav button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('active', s.getAttribute('data-view') === v));
      // Lazy refresh on view enter
      if (v === 'cluster') renderCluster();
      if (v === 'workers') renderWorkers();
      if (v === 'agents') renderAgents();
    });
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    if (!confirm('Forget admin token? You will need to paste it again to use the UI.')) return;
    clearToken();
    location.reload();
  });

  // ---------- Cluster view ----------
  async function renderCluster() {
    try {
      const r = await api('/v1/operator/cluster');
      const cards = document.getElementById('cluster-cards');
      cards.innerHTML = '';
      const items = [
        ['Total workers', r.workerCount.total],
        ['Active', r.workerCount.active],
        ['Draining', r.workerCount.draining],
        ['Evicted', r.workerCount.evicted],
        ['Capacity total', r.capacity.total],
        ['Capacity used', r.capacity.used],
        ['Capacity available', r.capacity.available],
        ['Agents', r.agentCount],
        ['Uptime (s)', r.uptimeSeconds],
      ];
      for (const [label, value] of items) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = \`<div class="label">\${label}</div><div class="value">\${value}</div>\`;
        cards.appendChild(card);
      }
    } catch (err) { showError(err); }
  }
  document.getElementById('cluster-refresh').addEventListener('click', renderCluster);

  // ---------- Workers view ----------
  async function renderWorkers() {
    try {
      const r = await api('/v1/operator/workers');
      const root = document.getElementById('workers-table');
      if (r.workers.length === 0) { root.innerHTML = '<p class="muted">No workers registered yet.</p>'; return; }
      const rows = r.workers.map((w) => \`
        <tr>
          <td><code>\${escapeHtml(w.workerId)}</code></td>
          <td><span class="pill \${w.state}">\${w.state}</span></td>
          <td>\${w.used} / \${w.capacity}</td>
          <td class="muted">\${escapeHtml(w.callbackUrl)}</td>
          <td class="muted">\${escapeHtml(w.labels?.machine ?? '—')}</td>
          <td class="muted">\${ageMs(w.heartbeatAt)}</td>
          <td class="row-actions">
            <button data-action="drain" data-worker="\${escapeAttr(w.workerId)}">Drain</button>
            <button data-action="undrain" data-worker="\${escapeAttr(w.workerId)}">Undrain</button>
            <button data-action="evict" data-worker="\${escapeAttr(w.workerId)}" class="danger">Evict</button>
          </td>
        </tr>\`).join('');
      root.innerHTML = \`<table>
        <thead><tr><th>Worker</th><th>State</th><th>Slots</th><th>Callback</th><th>Machine</th><th>Heartbeat</th><th></th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>\`;
      root.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = btn.getAttribute('data-action');
          const id = btn.getAttribute('data-worker');
          if (action === 'evict' && !confirm(\`Evict worker "\${id}"? Its agents will be released and need re-scheduling.\`)) return;
          try { await api(\`/v1/operator/workers/\${encodeURIComponent(id)}/\${action}\`, { method: 'POST', body: '{}' }); renderWorkers(); }
          catch (e) { showError(e); }
        });
      });
    } catch (err) { showError(err); }
  }
  document.getElementById('workers-refresh').addEventListener('click', renderWorkers);
  document.getElementById('workers-join').addEventListener('click', async () => {
    try {
      const r = await api('/v1/operator/workers/join-script', { method: 'POST', body: '{}' });
      const win = window.open('', '_blank', 'width=700,height=600');
      win.document.write('<pre style="padding:20px; font:13px ui-monospace, monospace; white-space:pre-wrap;">' + escapeHtml(r.script) + '</pre>');
      win.document.title = 'berry-worker join script';
    } catch (err) { showError(err); }
  });

  // ---------- Agents view ----------
  async function renderAgents() {
    try {
      const r = await api('/v1/agents');
      const root = document.getElementById('agents-table');
      document.getElementById('sessions-container').style.display = 'none';
      if (r.agents.length === 0) { root.innerHTML = '<p class="muted">No agents running.</p>'; return; }
      const rows = r.agents.map((a) => \`
        <tr data-agent="\${escapeAttr(a.agentId)}" style="cursor:pointer;">
          <td><code>\${escapeHtml(a.agentId)}</code></td>
          <td>\${a.workerId ? '<code>' + escapeHtml(a.workerId) + '</code>' : '<span class="muted">stranded</span>'}</td>
        </tr>\`).join('');
      root.innerHTML = \`<table>
        <thead><tr><th>Agent</th><th>Worker</th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>\`;
      root.querySelectorAll('tr[data-agent]').forEach((tr) => {
        tr.addEventListener('click', () => openAgentSessions(tr.getAttribute('data-agent')));
      });
    } catch (err) { showError(err); }
  }
  document.getElementById('agents-refresh').addEventListener('click', renderAgents);

  let currentEventStream = null;
  async function openAgentSessions(agentId) {
    try {
      const r = await api(\`/v1/agents/\${encodeURIComponent(agentId)}/sessions\`);
      const container = document.getElementById('sessions-container');
      container.style.display = '';
      document.getElementById('sessions-heading').textContent = \`Sessions for \${agentId}\`;
      const list = document.getElementById('sessions-list');
      if (r.sessions.length === 0) { list.innerHTML = '<p class="muted">No sessions yet.</p>'; return; }
      list.innerHTML = r.sessions.map((s) => \`
        <div class="session-row" data-session="\${escapeAttr(s.id)}">
          <span><code>\${escapeHtml(s.id)}</code> <span class="pill">\${s.status}</span></span>
          <span class="muted">\${ageMs(s.lastActiveAt)} · \${s.messageCount ?? 0} msgs</span>
        </div>\`).join('');
      list.querySelectorAll('.session-row').forEach((row) => {
        row.addEventListener('click', () => {
          list.querySelectorAll('.session-row').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          openSessionEvents(agentId, row.getAttribute('data-session'));
        });
      });
    } catch (err) { showError(err); }
  }

  function openSessionEvents(agentId, sessionId) {
    if (currentEventStream) { currentEventStream.close(); currentEventStream = null; }
    const container = document.getElementById('events-container');
    container.style.display = '';
    document.getElementById('events-heading').textContent = \`Events: \${sessionId}\`;
    const stream = document.getElementById('events-stream');
    stream.innerHTML = '<div class="muted">Connecting…</div>';
    // EventSource cannot send Authorization header — workaround: include
    // token in the URL query string is unsafe (cached in proxy logs).
    // Use fetch + ReadableStream for SSE-over-fetch.
    const token = getToken();
    const url = \`/v1/agents/\${encodeURIComponent(agentId)}/events/stream?session=\${encodeURIComponent(sessionId)}\`;
    const ctrl = new AbortController();
    currentEventStream = { close: () => ctrl.abort() };
    fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' }, signal: ctrl.signal })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) throw new Error('SSE HTTP ' + resp.status);
        stream.innerHTML = '';
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\\n\\n')) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const lines = block.split('\\n').filter((l) => !l.startsWith(':'));
            const type = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
            const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '';
            if (!type) continue;
            const row = document.createElement('div');
            row.className = 'event-row';
            row.innerHTML = '<span class="type">' + escapeHtml(type) + '</span> ' + escapeHtml(data.slice(0, 400));
            stream.appendChild(row);
            stream.scrollTop = stream.scrollHeight;
          }
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        stream.innerHTML = '<div class="err">' + escapeHtml(err.message) + '</div>';
      });
  }

  // ---------- Admin chat view ----------
  const chatStream = document.getElementById('chat-stream');
  const chatPrompt = document.getElementById('chat-prompt');
  const chatSend = document.getElementById('chat-send');

  function appendChat(role, content) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.textContent = content;
    chatStream.appendChild(div);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  async function sendChat() {
    const prompt = chatPrompt.value.trim();
    if (!prompt) return;
    chatPrompt.value = '';
    appendChat('user', prompt);
    chatSend.disabled = true;
    appendChat('system', 'berry-admin is thinking…');
    const placeholder = chatStream.lastChild;
    try {
      const r = await api('/v1/agents/berry-admin/send', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      placeholder.remove();
      const text = extractAssistantText(r) ?? '(no text in reply)';
      appendChat('assistant', text);
    } catch (err) {
      placeholder.remove();
      appendChat('system', 'Error: ' + (err.message || String(err)));
    } finally {
      chatSend.disabled = false;
      chatPrompt.focus();
    }
  }

  function extractAssistantText(turnResult) {
    // SendResponse.result is the opaque ManagedAgentTurnResult.
    // The simplest signal: result.result.text — the SDK's QueryResult shape.
    const t = turnResult?.result;
    if (typeof t?.result?.text === 'string') return t.result.text;
    if (typeof t?.assistantMessage?.content === 'string') return t.assistantMessage.content;
    return null;
  }

  chatSend.addEventListener('click', sendChat);
  chatPrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendChat(); }
  });

  // ---------- Utils ----------
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }
  function ageMs(ts) {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 0) return 'future';
    if (d < 60_000) return Math.round(d/1000) + 's ago';
    if (d < 3_600_000) return Math.round(d/60_000) + 'm ago';
    return Math.round(d/3_600_000) + 'h ago';
  }

  // ---------- Init ----------
  function refreshAll() {
    fetch('/v1/health').then((r) => r.json()).then((h) => {
      document.getElementById('version-line').textContent = 'a8s ' + h.version + ' · up ' + h.uptime + 's';
    }).catch(() => {});
    renderCluster();
  }
  if (!getToken()) showTokenModal();
  else refreshAll();
})();
</script>
</body>
</html>
`;
