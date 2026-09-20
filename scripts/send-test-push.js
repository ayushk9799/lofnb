import mongoose from "mongoose";
import dotenv from "dotenv";
import { UserModel } from "../src/models/user.model.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { sendChatPushNotification } from "../src/services/push-notification.service.js";

dotenv.config();

const targetEmail = process.argv[2] || "ayushkumarsanu00@gmail.com";
const testMessage = process.argv[3] || "Hey! This is a test notification from Lofn ✨";

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[TestPush] Connected to database.");

    const user = await UserModel.findOne({
        $or: [
            { email: new RegExp(targetEmail, "i") },
            { userId: targetEmail },
        ],
    }).lean();

    if (!user) {
        console.error(`[TestPush] No user found for: ${targetEmail}`);
        await mongoose.disconnect();
        process.exit(1);
    }

    if (!user.fcmToken) {
        console.error(`[TestPush] User ${user.email} (${user.userId}) does not have an FCM token registered.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`[TestPush] Sending to user: ${user.name || "User"} <${user.email}> (${user.platform || "unknown device"})`);

    const relationship = await RelationshipModel.findOne({ userId: user.userId })
        .populate("characterId")
        .lean();

    const characterName = relationship?.characterId?.name || "Elena Ramos";
    const characterAvatar = relationship?.characterId?.avatarUrl || "";
    const relationshipId = relationship?._id ? String(relationship._id) : "test-relationship";

    const success = await sendChatPushNotification({
        userId: user.userId,
        characterName,
        content: testMessage,
        relationshipId,
        avatarUrl: characterAvatar,
        extraData: {
            source: "manual_test",
            sentAt: new Date().toISOString(),
        },
    });

    if (success) {
        console.log(`[TestPush] ✅ Successfully sent notification from "${characterName}": "${testMessage}"`);
    } else {
        console.error("[TestPush] ❌ Failed to send push notification.");
    }

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error("[TestPush] Error:", err.message);
    process.exit(1);
});
