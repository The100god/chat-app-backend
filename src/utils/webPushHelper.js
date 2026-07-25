const webpush = require("web-push");
const User = require("../models/User");

// Set up VAPID details
const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const email = process.env.VAPID_EMAIL || "mailto:thesaurabhgoyal@gmail.com";

if (publicKey && privateKey) {
  webpush.setVapidDetails(email, publicKey, privateKey);
  console.log("🟢 Web Push VAPID keys configured successfully.");
} else {
  console.warn("⚠️ VAPID keys not configured. Web push notifications are disabled.");
}

/**
 * Sends a web push notification to all registered subscriptions of a user.
 * Automatically handles and purges dead or expired subscriptions (410 Gone / 404 Not Found).
 * 
 * @param {string} userId - ID of the recipient user
 * @param {object} payload - Notification payload object (will be serialized to JSON)
 */
const sendPushNotification = async (userId, payload) => {
  if (!publicKey || !privateKey) return;

  try {
    const user = await User.findById(userId);
    if (!user || !user.pushSubscriptions || user.pushSubscriptions.length === 0) {
      return;
    }

    const subscriptionsToRemove = [];
    
    const notificationPromises = user.pushSubscriptions.map(async (sub) => {
      // Reformat mongoose sub document to plain JSON expected by web-push if needed
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth
        }
      };

      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (error) {
        // 410 (Gone) or 404 (Not Found) means subscription has expired or is invalid
        if (error.statusCode === 410 || error.statusCode === 404) {
          console.log(`🗑️ Removing expired subscription endpoint: ${sub.endpoint}`);
          subscriptionsToRemove.push(sub.endpoint);
        } else {
          console.error("❌ Error sending push notification to endpoint:", sub.endpoint, error.message);
        }
      }
    });

    await Promise.all(notificationPromises);

    // If there are invalid subscriptions, remove them from the database
    if (subscriptionsToRemove.length > 0) {
      await User.findByIdAndUpdate(userId, {
        $pull: {
          pushSubscriptions: {
            endpoint: { $in: subscriptionsToRemove }
          }
        }
      });
    }
  } catch (err) {
    console.error("❌ Failed to process push notification sending for user:", userId, err);
  }
};

module.exports = {
  sendPushNotification,
  webpush
};
