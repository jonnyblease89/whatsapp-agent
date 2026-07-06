const { Firestore } = require('@google-cloud/firestore');

const db         = new Firestore();
const COLLECTION = 'conversations';
const MAX_HISTORY = 200;

async function getConversations() {
  const snap = await db.collection(COLLECTION).orderBy('lastMessageAt', 'desc').limit(100).get();
  return snap.docs.map(doc => {
    const d = doc.data();
    return {
      phone:         doc.id,
      customerName:  d.customerName  || null,
      status:        d.status        || 'bot',
      escalated:     d.escalated     || false,
      resolved:      d.resolved      || false,
      lastMessage:   d.lastMessage   || '',
      lastMessageAt: d.lastMessageAt?.toDate?.() || null,
    };
  });
}

async function getConversation(phone) {
  const doc = await db.collection(COLLECTION).doc(phone).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    phone,
    customerName:  d.customerName  || null,
    status:        d.status        || 'bot',
    escalated:     d.escalated     || false,
    resolved:      d.resolved      || false,
    messages:      d.messages      || [],
    lastMessageAt: d.lastMessageAt?.toDate?.() || null,
    twilioNumber:  d.twilioNumber  || null,
  };
}

async function getHistory(phone) {
  const doc = await db.collection(COLLECTION).doc(phone).get();
  if (!doc.exists) return [];
  return doc.data().messages || [];
}

async function saveHistory(phone, messages, meta = {}) {
  const last = messages[messages.length - 1];
  await db.collection(COLLECTION).doc(phone).set({
    messages,
    lastMessage:   last?.content?.slice(0, 120) || '',
    lastMessageAt: new Date(),
    updatedAt:     new Date(),
    ...meta,
  }, { merge: true });
}

async function appendIanMessage(phone, content) {
  const history  = await getHistory(phone);
  const messages = [...history, { role: 'assistant', content, sender: 'ian', ts: new Date().toISOString() }];
  const trimmed  = messages.length > MAX_HISTORY ? messages.slice(-MAX_HISTORY) : messages;
  await saveHistory(phone, trimmed, { lastMessage: content.slice(0, 120) });
}

async function setStatus(phone, status) {
  await db.collection(COLLECTION).doc(phone).set({ status }, { merge: true });
}

async function getStatus(phone) {
  const doc = await db.collection(COLLECTION).doc(phone).get();
  return doc.exists ? (doc.data().status || 'bot') : 'bot';
}

async function setResolved(phone, resolved) {
  await db.collection(COLLECTION).doc(phone).set({ resolved }, { merge: true });
}

async function clearHistory(phone) {
  await db.collection(COLLECTION).doc(phone).delete();
}

// Atomically claims a Twilio MessageSid so retried webhook deliveries (Twilio resends if it
// doesn't get a fast 200) don't get processed — and replied to — twice. Returns false if this
// SID was already claimed. Relies on Firestore's create() failing on an existing document,
// which is atomic, rather than a get-then-set check which would race.
async function claimMessage(sid) {
  try {
    await db.collection('processed_messages').doc(sid).create({ processedAt: new Date() });
    return true;
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) return false;
    throw err;
  }
}

module.exports = { getConversations, getConversation, getHistory, saveHistory, appendIanMessage, setStatus, getStatus, setResolved, clearHistory, claimMessage };
