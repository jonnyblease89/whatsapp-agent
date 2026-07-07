// Dedicated low-value token for this staging page only — separate from the real inbox
// password, so it can be baked in here with no login screen. If it ever leaks, it only
// allows sending test messages to the AI, not reading real customer conversations.
const TEST_TOKEN = '91c9b52395639ce83fdce922849e17b53df1545b0ecff4d9';

const messagesEl = document.getElementById('messages');
const input      = document.getElementById('reply-input');
const sendBtn    = document.getElementById('send-btn');

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function appendBubble(role, content, escalated = false) {
  messagesEl.querySelector('.empty')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${role === 'user' ? 'in' : 'out'}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg';
  bubble.innerHTML = escapeHtml(content);
  wrap.appendChild(bubble);
  if (escalated) {
    const flag = document.createElement('div');
    flag.className = 'escalate-flag';
    flag.textContent = '⚠️ [ESCALATE] — bot would hand off to Ian here';
    wrap.appendChild(flag);
  }
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap out';
  wrap.id = 'typing-indicator';
  wrap.innerHTML = `<div class="msg"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function hideTyping() {
  document.getElementById('typing-indicator')?.remove();
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  sendBtn.disabled = true;

  appendBubble('user', text);
  showTyping();

  try {
    const res = await fetch('../test-chat', {
      method: 'POST',
      headers: { 'x-test-token': TEST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    hideTyping();

    const data = await res.json();
    if (!res.ok) {
      appendBubble('assistant', `⚠️ ${data.error || 'Request failed'}`);
      return;
    }
    appendBubble('assistant', data.reply, data.escalated);
  } catch {
    hideTyping();
    appendBubble('assistant', '⚠️ Network error — try again');
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.addEventListener('click', sendMessage);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
});

input.focus();
