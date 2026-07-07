const API = 'https://europe-west2-trans-invention-392414.cloudfunctions.net/whatsapp-agent';

let token           = localStorage.getItem('inbox_token') || '';
let currentPhone    = null;
let pollTimer       = null;
let summaryTimer    = null;
let allConvs        = [];
let initialChatLoad = false; // true only for the very first render of a chat
let isAway          = false;

// ── Screens ───────────────────────────────────────────────────────────────────

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ── API ───────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'x-inbox-token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  } catch { return null; }
}

// ── Login ─────────────────────────────────────────────────────────────────────

document.getElementById('login-btn').addEventListener('click', async () => {
  token = document.getElementById('token-input').value.trim();
  const data = await api('GET', '/conversations');
  if (!data) {
    document.getElementById('login-error').classList.remove('hidden');
    return;
  }
  localStorage.setItem('inbox_token', token);
  allConvs = data;
  renderList();
  show('list-screen');
  loadSummary();
  loadGarageConfig();
  startListPoll();
  startSummaryRefresh();
  setupPush();
});

document.getElementById('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('logout-btn').addEventListener('click', logout);

function logout() {
  localStorage.removeItem('inbox_token');
  token = '';
  stopPoll();
  stopSummaryRefresh();
  show('login-screen');
}

// ── Main tabs (Inbox / Summary) ───────────────────────────────────────────────

document.querySelectorAll('.main-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const pane = tab.dataset.tab;
    document.getElementById('inbox-pane').classList.toggle('hidden', pane !== 'inbox');
    document.getElementById('summary-pane').classList.toggle('hidden', pane !== 'summary');
  });
});

document.getElementById('summary-refresh-btn').addEventListener('click', loadSummary);

// ── Conversation list ─────────────────────────────────────────────────────────

function renderList() {
  const el    = document.getElementById('conversation-list');
  const empty = document.getElementById('list-empty');

  // Active conversations first (most recent), resolved pushed to bottom
  const sorted = [...allConvs].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt) : new Date(0);
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt) : new Date(0);
    return tb - ta;
  });

  if (!sorted.length) { el.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  el.innerHTML = sorted.map(c => {
    const name      = c.customerName || c.phone;
    const initial   = name[0].toUpperCase();
    const time      = c.lastMessageAt ? timeAgo(new Date(c.lastMessageAt)) : '';
    const avatarCls = c.escalated ? 'escalated' : c.resolved ? 'resolved' : c.status === 'human' ? 'human' : '';
    const itemCls   = [c.unread ? 'unread' : '', c.escalated ? 'escalated' : ''].filter(Boolean).join(' ');
    const badge     = c.resolved
      ? '<span class="badge resolved">✓ Done</span>'
      : c.escalated
        ? '<span class="badge escalated">⚠ Needs Ian</span>'
        : c.status === 'human'
          ? '<span class="badge human">You</span>'
          : '<span class="badge bot">Bot</span>';
    const dot     = c.unread ? '<span class="unread-dot"></span>' : '';
    const preview = String(c.lastMessage || 'No messages yet').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `<div class="conv-item ${itemCls}" data-phone="${c.phone}">
      <div class="conv-avatar ${avatarCls}">${initial}</div>
      <div class="conv-body">
        <div class="conv-name">${name}</div>
        <div class="conv-preview">${preview}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">${time}</div>
        ${dot}
        ${badge}
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.conv-item').forEach(item => {
    item.addEventListener('click', () => openChat(item.dataset.phone));
  });
}

function startListPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    if (currentPhone) return;
    const data = await api('GET', '/conversations');
    if (data) { allConvs = data; renderList(); }
  }, 5000);
}

// Render the simple markdown Claude produces (bold, bullets, newlines)
function renderMarkdown(md) {
  return md
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // **bold**
    .replace(/^[•·]\s+/gm, '&bull; ')                 // bullet chars
    .replace(/\n/g, '<br>');
}

async function loadSummary() {
  const el = document.getElementById('summary-content');
  if (!el) return;
  el.innerHTML = '<span style="opacity:0.5">Loading today\'s summary…</span>';

  const data = await api('GET', '/inbox-summary');
  if (data?.summary) {
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    el.innerHTML = `<strong>Today · ${today}</strong><br><br>${renderMarkdown(data.summary)}`;
  } else {
    el.innerHTML = '<span style="opacity:0.5">No conversations today yet.</span>';
  }
}

// ── Away mode ─────────────────────────────────────────────────────────────────

async function loadGarageConfig() {
  const config = await api('GET', '/garage-config');
  if (!config) return;
  const awayUntil = config.awayUntil ? new Date(config.awayUntil) : null;
  const activelyAway = awayUntil && awayUntil > new Date();
  isAway = !!activelyAway;
  document.getElementById('away-btn').classList.toggle('away-active', isAway);
  if (isAway) {
    const dateStr = awayUntil.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    document.getElementById('away-text').textContent = `Away mode — Ian back ${dateStr}. Bot won't take bookings.`;
    document.getElementById('away-banner').classList.remove('hidden');
  } else {
    document.getElementById('away-banner').classList.add('hidden');
  }
}

document.getElementById('away-btn').addEventListener('click', () => {
  if (isAway) {
    // toggle off
    setAwayMode(null);
  } else {
    // show date picker
    const form = document.getElementById('away-form');
    const isVisible = !form.classList.contains('hidden');
    form.classList.toggle('hidden', isVisible);
    if (!isVisible) {
      const today = new Date().toISOString().slice(0, 10);
      const input = document.getElementById('away-date-input');
      input.min   = today;
      input.value = '';
      input.focus();
    }
  }
});

document.getElementById('away-confirm-btn').addEventListener('click', async () => {
  const val = document.getElementById('away-date-input').value;
  if (!val) return;
  document.getElementById('away-form').classList.add('hidden');
  await setAwayMode(val);
});

document.getElementById('away-form-dismiss').addEventListener('click', () => {
  document.getElementById('away-form').classList.add('hidden');
});

document.getElementById('away-cancel-btn').addEventListener('click', () => setAwayMode(null));

document.getElementById('away-date-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('away-confirm-btn').click();
});

async function setAwayMode(dateStr) {
  await api('POST', '/away', { awayUntil: dateStr });
  await loadGarageConfig();
}

// ── Chat view ─────────────────────────────────────────────────────────────────

async function openChat(phone) {
  currentPhone    = phone;
  initialChatLoad = true;
  show('chat-screen');
  await refreshChat();
  startChatPoll();
}

async function refreshChat() {
  const conv = await api('GET', `/conversations/${encodeURIComponent(currentPhone)}`);
  if (!conv) return;

  document.getElementById('chat-name').textContent  = conv.customerName || conv.phone;
  document.getElementById('chat-phone').textContent = conv.customerName ? conv.phone : '';

  const isHuman    = conv.status === 'human';
  const isResolved = conv.resolved;

  document.getElementById('human-banner').classList.toggle('hidden', !isHuman);

  const toggleBtn = document.getElementById('toggle-btn');
  if (isHuman) {
    toggleBtn.textContent = '🤖 Bot';
    toggleBtn.onclick = () => handback();
  } else {
    toggleBtn.textContent = '👤 Take over';
    toggleBtn.onclick = () => takeover();
  }

  const resolveBtn = document.getElementById('resolve-btn');
  resolveBtn.disabled   = false;
  resolveBtn.dataset.resolved = isResolved ? '1' : '0';
  resolveBtn.textContent = isResolved ? '↩ Reopen' : '✓ Resolve';

  document.getElementById('reply-input').disabled = isResolved;
  document.getElementById('send-btn').disabled    = isResolved;

  renderMessages(conv.messages || []);
}

function renderMessages(messages) {
  const el = document.getElementById('messages');

  // Count existing rendered bubbles
  const renderedCount = el.querySelectorAll('.msg-wrap').length;
  const isFirst = initialChatLoad;
  initialChatLoad = false;

  // Skip full re-render if message count hasn't changed — preserves scroll position
  if (!isFirst && renderedCount === messages.length) return;

  // Decide scroll behaviour before wiping the DOM
  const prevScrollTop    = el.scrollTop;
  const prevScrollHeight = el.scrollHeight;
  const nearBottom       = prevScrollHeight - prevScrollTop - el.clientHeight < 120;
  const shouldScroll     = isFirst || nearBottom;

  let lastDate = null;
  let html = '';

  messages.forEach(m => {
    const isOut = m.role === 'assistant';
    const sender = m.sender || (isOut ? 'bot' : 'customer');
    const dir    = isOut ? 'out' : 'in';
    const ianCls = sender === 'ian' ? ' ian' : '';

    const ts      = m.ts ? new Date(m.ts) : null;
    const time    = ts ? ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const dateStr = ts ? ts.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;

    if (dateStr && dateStr !== lastDate) {
      html += `<div class="day-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
    }

    const label = sender === 'ian' ? ' · Ian' : sender === 'bot' ? ' · Bot' : '';

    html += `<div class="msg-wrap ${dir}${ianCls}">
      <div class="msg">${escapeHtml(m.content)}<div class="msg-meta">${time}${label}</div></div>
    </div>`;
  });

  el.innerHTML = html;

  if (shouldScroll) {
    el.scrollTop = el.scrollHeight;
  } else {
    // Restore position adjusted for newly added content height
    el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function startChatPoll() {
  stopPoll();
  pollTimer = setInterval(refreshChat, 5000);
}

document.getElementById('back-btn').addEventListener('click', () => {
  currentPhone = null;
  stopPoll();
  show('list-screen');
  startListPoll();
  loadSummary(); // refresh summary when returning from a chat
  api('GET', '/conversations').then(data => { if (data) { allConvs = data; renderList(); } });
});

document.getElementById('resolve-btn').addEventListener('click', () => {
  const btn = document.getElementById('resolve-btn');
  const resolving = btn.dataset.resolved !== '1';
  setResolved(resolving);
});

document.getElementById('send-btn').addEventListener('click', sendReply);
document.getElementById('reply-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});

// Auto-grow textarea
document.getElementById('reply-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});

async function sendReply() {
  const input   = document.getElementById('reply-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  input.style.height = 'auto';
  await api('POST', '/reply', { phone: currentPhone, message });
  await refreshChat();
}

async function takeover() {
  await api('POST', '/takeover', { phone: currentPhone });
  await refreshChat();
}

async function handback() {
  await api('POST', '/handback', { phone: currentPhone });
  await refreshChat();
}

async function setResolved(resolved) {
  const btn = document.getElementById('resolve-btn');
  btn.disabled    = true;
  btn.textContent = '…';
  const result = await api('POST', '/resolve', { phone: currentPhone, resolved });
  if (!result) { await refreshChat(); return; } // re-enable on error
  const idx = allConvs.findIndex(c => c.phone === currentPhone);
  if (idx !== -1) allConvs[idx].resolved = resolved;
  await refreshChat();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startSummaryRefresh() {
  if (summaryTimer) clearInterval(summaryTimer);
  summaryTimer = setInterval(loadSummary, 15 * 60 * 1000); // refresh every 15 minutes
}

function stopSummaryRefresh() {
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
}

function timeAgo(date) {
  const diff = Math.round((Date.now() - date) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Push notifications ────────────────────────────────────────────────────────

async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  const existing = await reg.pushManager.getSubscription();
  if (existing) { await api('POST', '/subscribe', existing.toJSON()); return; }
  const { key } = await api('GET', '/vapid-public-key');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await api('POST', '/subscribe', sub.toJSON());
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

if (token) {
  api('GET', '/conversations').then(data => {
    if (data) {
      allConvs = data;
      renderList();
      show('list-screen');
      loadSummary();
      loadGarageConfig();
      startListPoll();
      startSummaryRefresh();
      setupPush();
    } else {
      show('login-screen');
    }
  });
} else {
  show('login-screen');
}
