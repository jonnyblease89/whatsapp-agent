// Dedicated low-value token for this staging page only — separate from the real inbox
// password, so it can be baked in here with no login screen. If it ever leaks, it only
// allows sending test messages to the AI, not reading real customer conversations.
const TEST_TOKEN = '91c9b52395639ce83fdce922849e17b53df1545b0ecff4d9';

// The running conversation for this tab only — lost on refresh (ephemeral), never sent
// to Firestore. Sent in full on every turn so the AI has real context, same as a real
// SMS thread would build up.
const thread = [];

const messagesEl     = document.getElementById('messages');
const input          = document.getElementById('reply-input');
const sendBtn        = document.getElementById('send-btn');
const phoneInput     = document.getElementById('phone-input');
const customerStatus = document.getElementById('customer-status');

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
    flag.textContent = '⚠️ [ESCALATE] — bot would hand off to Ian here (would go quiet until he replies)';
    wrap.appendChild(flag);
  }
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

function updateCustomerStatus(known, name) {
  customerStatus.classList.remove('known', 'unknown');
  if (!phoneInput.value.trim()) {
    customerStatus.textContent = '';
    return;
  }
  if (known) {
    customerStatus.textContent = `✅ Known: ${name}`;
    customerStatus.classList.add('known');
  } else {
    customerStatus.textContent = '🆕 New customer';
    customerStatus.classList.add('unknown');
  }
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

  thread.push({ role: 'user', content: text });
  appendBubble('user', text);
  showTyping();

  try {
    const res = await fetch('../test-chat', {
      method: 'POST',
      headers: { 'x-test-token': TEST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: thread, phone: phoneInput.value.trim() }),
    });
    hideTyping();

    const data = await res.json();
    if (!res.ok) {
      thread.pop(); // roll back so the thread stays valid (strict user/assistant alternation) — retry re-adds cleanly
      appendBubble('assistant', `⚠️ ${data.error || 'Request failed'}`);
      input.value = text;
      return;
    }
    thread.push({ role: 'assistant', content: data.reply });
    appendBubble('assistant', data.reply, data.escalated);
    updateCustomerStatus(data.customerKnown, data.customerName);
  } catch {
    hideTyping();
    thread.pop();
    appendBubble('assistant', '⚠️ Network error — try again');
    input.value = text;
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

phoneInput.addEventListener('input', () => {
  // Stale until the next message is sent and re-looked-up under the new number
  customerStatus.textContent = '';
  customerStatus.classList.remove('known', 'unknown');
});

input.focus();
