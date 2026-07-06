const webpush   = require('web-push');
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();
const COLLECTION = 'push_subscriptions';

webpush.setVapidDetails(
  'mailto:admin@chautoworks.co.uk',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function saveSubscription(subscription) {
  // Use a hash of the endpoint as the doc ID to avoid duplicates
  const id = Buffer.from(subscription.endpoint).toString('base64').slice(0, 64);
  await db.collection(COLLECTION).doc(id).set({ subscription, updatedAt: new Date() });
}

async function sendPush(title, body) {
  const snap = await db.collection(COLLECTION).get();
  const payload = JSON.stringify({ title, body });

  await Promise.allSettled(
    snap.docs.map(async doc => {
      try {
        await webpush.sendNotification(doc.data().subscription, payload);
      } catch (err) {
        // Subscription expired or invalid — remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await doc.ref.delete();
        }
      }
    })
  );
}

module.exports = { saveSubscription, sendPush };
