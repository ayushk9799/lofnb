import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserModel } from "../models/user.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let isInitialized = false;
let initFailedLogged = false;

export function initializeFirebase() {
    if (isInitialized) return true;
    try {
        const apps = getApps();
        if (apps && apps.length > 0) {
            isInitialized = true;
            return true;
        }

        // Check for serviceAccountKey file or environment variable
        const potentialPaths = [
            process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
            path.resolve(__dirname, "../../serviceAccountKey.json"),
            path.resolve(process.cwd(), "serviceAccountKey.json"),
        ].filter(Boolean);

        let credential;
        for (const filePath of potentialPaths) {
            if (fs.existsSync(filePath)) {
                try {
                    const raw = fs.readFileSync(filePath, "utf-8");
                    credential = cert(JSON.parse(raw));
                    break;
                } catch (e) {
                    console.warn(`[Push] Failed to parse service account at ${filePath}:`, e.message);
                }
            }
        }

        if (!credential && process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
            } catch (e) {
                console.warn("[Push] Failed to parse FIREBASE_SERVICE_ACCOUNT env:", e.message);
            }
        }

        if (!credential) {
            if (!initFailedLogged) {
                console.info("[Push] Firebase Admin uninitialized: serviceAccountKey.json not found (push notifications will be enabled once configured).");
                initFailedLogged = true;
            }
            return false;
        }

        initializeApp({ credential });
        isInitialized = true;
        console.info("[Push] Firebase Admin initialized successfully.");
        return true;
    } catch (error) {
        if (!initFailedLogged) {
            console.warn("[Push] Firebase Admin initialization error:", error.message);
            initFailedLogged = true;
        }
        return false;
    }
}

// Auto-attempt initialization on load
initializeFirebase();

/**
 * Calculate total unread assistant messages across all relationships for a user.
 * Strictly counts messages with sequenceNumber > userLastReadSequence.
 * Does not count empty/new matches without unread messages.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
export const getUserUnreadMessageCount = async (userId) => {
    const relationships = await RelationshipModel.find({ userId })
        .select("_id userLastReadSequence")
        .lean();
    if (!relationships || relationships.length === 0) return 0;
    const unreadCounts = await Promise.all(
        relationships.map((rel) =>
            MessageModel.countDocuments({
                relationshipId: rel._id,
                role: "assistant",
                sequenceNumber: { $gt: rel.userLastReadSequence || 0 },
            })
        )
    );
    return unreadCounts.reduce((sum, count) => sum + count, 0);
};

/**
 * Send a chat push notification to a user for a character message.
 *
 * @param {Object} options
 * @param {string} options.userId - Target user's userId
 * @param {string} options.characterName - Name of the character sending the message
 * @param {string} options.content - The text message content
 * @param {string|Object} options.relationshipId - The relationship ID for deep linking
 * @param {Object} [options.extraData] - Any extra payload data
 * @returns {Promise<boolean>}
 */
export const sendChatPushNotification = async ({
    userId,
    characterName,
    content,
    relationshipId,
    avatarUrl,
    extraData = {},
}) => {
    try {
        if (!initializeFirebase()) {
            return false;
        }

        const user = await UserModel.findOne({ userId }).lean();
        if (!user?.fcmToken) {
            return false;
        }

        const cleanRelationshipId = String(relationshipId || "");
        const title = characterName || "New message";
        const body = (content || "").slice(0, 150);
        const resolvedAvatarUrl = avatarUrl || extraData?.avatarUrl || extraData?.imageUrl || "";

        let badgeCount = 1;
        try {
            const unreadTotal = await getUserUnreadMessageCount(userId);
            badgeCount = Math.max(1, unreadTotal);
        } catch (badgeErr) {
            console.warn("[Push] Error calculating unread badge count:", badgeErr.message);
        }

        // Keep the cross-platform notification payload text-only. Supplying an
        // imageUrl here also adds it to APNs, where it requires a Notification
        // Service Extension to download the image. Without that extension iOS
        // renders an empty/black attachment tile instead of the app icon.
        // Android receives its image through android.notification below.
        const notificationPayload = {
            title,
            body,
        };

        const androidNotificationPayload = {
            sound: "default",
            channelId: "lofn-chat-messages",
            icon: "ic_notification",
            color: "#FF2D62",
            ...(resolvedAvatarUrl ? { imageUrl: resolvedAvatarUrl } : {}),
        };

        const message = {
            token: user.fcmToken,
            notification: notificationPayload,
            data: {
                type: "chat_message",
                relationshipId: cleanRelationshipId,
                characterName: title,
                ...(resolvedAvatarUrl ? { avatarUrl: resolvedAvatarUrl } : {}),
                ...Object.fromEntries(
                    Object.entries(extraData).map(([k, v]) => [k, String(v)])
                ),
                timestamp: new Date().toISOString(),
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-push-type": "alert",
                },
                payload: {
                    aps: {
                        alert: {
                            title,
                            body,
                        },
                        sound: "default",
                        badge: badgeCount,
                    },
                },
            },
            android: {
                priority: "high",
                notification: androidNotificationPayload,
            },
        };

        const messaging = getMessaging();
        await messaging.send(message);
        return true;
    } catch (error) {
        // Automatically clean up stale or unregistered FCM tokens
        if (
            error.code === "messaging/registration-token-not-registered" ||
            error.code === "messaging/invalid-registration-token"
        ) {
            console.warn(`[Push] Removing invalid FCM token for user ${userId}`);
            await UserModel.updateOne({ userId }, { $unset: { fcmToken: 1 } }).catch(() => {});
        } else {
            console.error("[Push] Failed to send push notification:", error.message);
        }
        return false;
    }
};
