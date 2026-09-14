import { Router } from "express";
import { UserModel } from "../models/user.model.js";
import { HttpError } from "../utils/http-error.js";

export function createWebhookRouter({ env }) {
    const router = Router();

    router.post("/revenuecat", async (request, response) => {
        // Optional webhook authorization check
        if (env?.REVENUECAT_WEBHOOK_SECRET) {
            const authHeader = request.header("authorization")?.trim();
            const expected = `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`;
            if (authHeader !== expected && authHeader !== env.REVENUECAT_WEBHOOK_SECRET) {
                throw new HttpError(401, "Invalid webhook authorization header", "UNAUTHORIZED");
            }
        }

        const body = request.body || {};
        const event = body.event;
        if (!event || !event.type) {
            return response.status(400).json({
                success: false,
                message: "Missing event in webhook payload",
            });
        }

        const appUserId = event.app_user_id || event.original_app_user_id;
        if (!appUserId) {
            return response.status(200).json({
                success: true,
                processed: false,
                reason: "missing_app_user_id",
            });
        }

        // Find user by userId or existing revenueCatAppUserId
        const user = await UserModel.findOne({
            $or: [
                { userId: appUserId },
                { revenueCatAppUserId: appUserId },
                ...(event.original_app_user_id ? [{ userId: event.original_app_user_id }] : []),
            ],
        });

        if (!user) {
            console.info(`[RevenueCat Webhook] User not found for appUserId: ${appUserId}`);
            return response.status(200).json({
                success: true,
                processed: false,
                reason: "user_not_found",
            });
        }

        const type = String(event.type).toUpperCase();
        const entitlementId =
            event.entitlement_id ||
            (Array.isArray(event.entitlement_ids) && event.entitlement_ids[0]) ||
            event.product_id ||
            "premium";

        const expirationMs = event.expiration_at_ms;
        const expiresAt = expirationMs ? new Date(expirationMs) : undefined;

        switch (type) {
            case "INITIAL_PURCHASE":
            case "RENEWAL":
            case "UNCANCELLATION":
            case "PRODUCT_CHANGE":
                user.isPremium = true;
                user.premiumEntitlement = entitlementId;
                if (expiresAt) user.premiumExpiresAt = expiresAt;
                user.revenueCatAppUserId = appUserId;
                await user.save();
                console.info(`[RevenueCat Webhook] Activated premium for user ${user.userId}`);
                break;

            case "CANCELLATION":
                // User cancelled auto-renewal, but remains active until expiration_at_ms
                if (expiresAt && expiresAt <= new Date()) {
                    user.isPremium = false;
                }
                if (expiresAt) user.premiumExpiresAt = expiresAt;
                await user.save();
                console.info(`[RevenueCat Webhook] Recorded cancellation for user ${user.userId}`);
                break;

            case "EXPIRATION":
                user.isPremium = false;
                if (expiresAt) user.premiumExpiresAt = expiresAt;
                await user.save();
                console.info(`[RevenueCat Webhook] Expired subscription for user ${user.userId}`);
                break;

            default:
                console.info(`[RevenueCat Webhook] Ignored unhandled event type: ${type}`);
                break;
        }

        return response.status(200).json({
            success: true,
            processed: true,
            eventType: type,
            userId: user.userId,
            isPremium: user.isPremium,
        });
    });

    return router;
}
