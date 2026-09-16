import { Router } from "express";
import { UserModel } from "../models/user.model.js";
import { RevenueCatEventModel } from "../models/revenuecat-event.model.js";
import { SubscriptionTransactionModel } from "../models/subscription-transaction.model.js";
import { HttpError } from "../utils/http-error.js";

export function createWebhookRouter({ env }) {
    const router = Router();

    router.post("/revenuecat", async (request, response) => {
        const webhookSecret = env?.REVENUECAT_WEBHOOK_SECRET;
        if (!webhookSecret && env?.NODE_ENV === "production") {
            throw new HttpError(503, "RevenueCat webhook authorization is not configured", "NOT_CONFIGURED");
        }
        if (webhookSecret) {
            const authHeader = request.header("authorization")?.trim();
            const expected = `Bearer ${webhookSecret}`;
            if (authHeader !== expected && authHeader !== webhookSecret) {
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

        const customerIds = [...new Set([
            event.app_user_id,
            event.original_app_user_id,
            ...(Array.isArray(event.aliases) ? event.aliases : []),
        ].filter((value) => typeof value === "string" && value.length > 0))];
        if (customerIds.length === 0) {
            return response.status(200).json({
                success: true,
                processed: false,
                reason: "missing_app_user_id",
            });
        }

        // accountId/revenueCatAppUserId are opaque and provider-scoped. The
        // legacy userId lookup preserves subscriptions created before migration.
        const user = await UserModel.findOne({
            $or: [
                { accountId: { $in: customerIds } },
                { revenueCatAppUserId: { $in: customerIds } },
                { userId: { $in: customerIds } },
            ],
        });

        if (!user) {
            console.info(`[RevenueCat Webhook] User not found for RevenueCat customer IDs: ${customerIds.join(", ")}`);
            return response.status(200).json({
                success: true,
                processed: false,
                reason: "user_not_found",
            });
        }

        const type = String(event.type).toUpperCase();
        const managedEntitlement = env?.REVENUECAT_ENTITLEMENT_ID || "premium";
        const entitlementIds = [...new Set([
            ...(Array.isArray(event.entitlement_ids) ? event.entitlement_ids : []),
            event.entitlement_id,
        ].filter(Boolean))];
        const premiumLifecycleTypes = new Set([
            "INITIAL_PURCHASE",
            "RENEWAL",
            "UNCANCELLATION",
            "PRODUCT_CHANGE",
            "NON_RENEWING_PURCHASE",
            "SUBSCRIPTION_EXTENDED",
            "REFUND_REVERSED",
            "CANCELLATION",
            "EXPIRATION",
        ]);

        if (premiumLifecycleTypes.has(type) && !entitlementIds.includes(managedEntitlement)) {
            return response.status(200).json({
                success: true,
                processed: false,
                reason: "unmanaged_entitlement",
            });
        }

        if (event.id) {
            try {
                await RevenueCatEventModel.create({ eventId: event.id, eventType: type });
            } catch (error) {
                if (error?.code === 11000) {
                    return response.status(200).json({
                        success: true,
                        processed: false,
                        reason: "duplicate_event",
                    });
                }
                throw error;
            }
        }

        const expirationMs = event.expiration_at_ms;
        const expiresAt = expirationMs ? new Date(expirationMs) : undefined;
        const eventAt = event.event_timestamp_ms ? new Date(event.event_timestamp_ms) : new Date();

        if (user.revenueCatEventAt && eventAt < user.revenueCatEventAt) {
            return response.status(200).json({
                success: true,
                processed: false,
                reason: "stale_event",
            });
        }

        try {
            switch (type) {
                case "INITIAL_PURCHASE":
                case "RENEWAL":
                case "UNCANCELLATION":
                case "PRODUCT_CHANGE":
                case "NON_RENEWING_PURCHASE":
                case "SUBSCRIPTION_EXTENDED":
                case "REFUND_REVERSED":
                    user.isPremium = true;
                    user.premiumEntitlement = managedEntitlement;
                    if (expiresAt) user.premiumExpiresAt = expiresAt;
                    user.revenueCatEventAt = eventAt;
                    await user.save();
                    console.info(`[RevenueCat Webhook] Activated premium for user ${user.userId}`);
                    break;

                case "CANCELLATION":
                    // Cancellation disables renewal, but access remains until expiration.
                    if (expiresAt && expiresAt <= new Date()) user.isPremium = false;
                    if (expiresAt) user.premiumExpiresAt = expiresAt;
                    user.revenueCatEventAt = eventAt;
                    await user.save();
                    console.info(`[RevenueCat Webhook] Recorded cancellation for user ${user.userId}`);
                    break;

                case "EXPIRATION":
                    user.isPremium = false;
                    user.premiumEntitlement = "";
                    if (expiresAt) user.premiumExpiresAt = expiresAt;
                    user.revenueCatEventAt = eventAt;
                    await user.save();
                    console.info(`[RevenueCat Webhook] Expired subscription for user ${user.userId}`);
                    break;

                case "BILLING_ISSUE":
                    // Do not revoke during a billing issue/grace period. EXPIRATION
                    // is the authoritative access-revocation event.
                    console.info(`[RevenueCat Webhook] Recorded billing issue for user ${user.userId}`);
                    break;

                default:
                    console.info(`[RevenueCat Webhook] Ignored unhandled event type: ${type}`);
                    return response.status(200).json({
                        success: true,
                        processed: false,
                        reason: "unhandled_event",
                    });
            }

            if (event.id) {
                const price = typeof event.price_in_purchased_currency === "number"
                    ? event.price_in_purchased_currency
                    : (typeof event.price === "number" ? event.price : 0);
                const currency = event.currency || "USD";
                const productId = event.product_id || "";
                const store = event.store || "UNKNOWN";
                const environment = event.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
                const countryCode = event.country_code || "";
                const periodType = event.period_type || "NORMAL";
                const renewalNumber = typeof event.renewal_number === "number" ? event.renewal_number : 1;
                const isTrialConversion = Boolean(event.is_trial_conversion);
                const cancelReason = event.cancel_reason || "";
                const purchasedAt = event.purchased_at_ms
                    ? new Date(event.purchased_at_ms)
                    : (event.event_timestamp_ms ? new Date(event.event_timestamp_ms) : new Date());

                await SubscriptionTransactionModel.create({
                    userId: user.userId,
                    revenueCatAppUserId: event.app_user_id || user.revenueCatAppUserId,
                    eventId: event.id,
                    eventType: type,
                    productId,
                    price,
                    currency,
                    store,
                    environment,
                    countryCode,
                    periodType,
                    renewalNumber,
                    isTrialConversion,
                    cancelReason,
                    purchasedAt,
                    expiresAt,
                    rawPayload: event,
                });
            }
        } catch (error) {
            if (event.id) {
                await RevenueCatEventModel.deleteOne({ eventId: event.id }).catch(() => {});
                await SubscriptionTransactionModel.deleteOne({ eventId: event.id }).catch(() => {});
            }
            throw error;
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
