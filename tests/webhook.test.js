import { describe, expect, it, vi, beforeEach } from "vitest";
import { createWebhookRouter } from "../src/routes/webhook.routes.js";
import { UserModel } from "../src/models/user.model.js";
import { RevenueCatEventModel } from "../src/models/revenuecat-event.model.js";
import { SubscriptionTransactionModel } from "../src/models/subscription-transaction.model.js";

function createMockReqRes({ method = "POST", url = "/revenuecat", headers = {}, body = {} } = {}) {
    const req = {
        method,
        url,
        headers,
        header(name) {
            return headers[name.toLowerCase()];
        },
        body,
    };

    let statusCode = 200;
    let jsonBody = null;
    const resHeaders = {};

    const res = {
        status(code) {
            statusCode = code;
            return res;
        },
        setHeader(k, v) {
            resHeaders[k] = v;
            return res;
        },
        json(data) {
            jsonBody = data;
            return res;
        },
        get statusCode() {
            return statusCode;
        },
        get body() {
            return jsonBody;
        },
    };

    return { req, res };
}

async function invokeRouter(router, req, res) {
    let nextError = null;
    await new Promise((resolve) => {
        const origJson = res.json;
        res.json = (data) => {
            origJson(data);
            resolve();
        };

        router.handle(req, res, (err) => {
            if (err) nextError = err;
            resolve();
        });
    });
    return nextError;
}

describe("RevenueCat Webhook Routes", () => {
    const mockEnvWithSecret = {
        REVENUECAT_WEBHOOK_SECRET: "my_secret_token_123",
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("rejects unauthorized requests when webhook secret is configured", async () => {
        const router = createWebhookRouter({ env: mockEnvWithSecret });
        const { req, res } = createMockReqRes({
            headers: { authorization: "Bearer wrong_secret" },
            body: { event: { type: "INITIAL_PURCHASE" } },
        });

        const error = await invokeRouter(router, req, res);

        expect(error).toBeDefined();
        expect(error.status).toBe(401);
    });

    it("accepts authorized requests when webhook secret matches", async () => {
        vi.spyOn(UserModel, "findOne").mockResolvedValue(null);

        const router = createWebhookRouter({ env: mockEnvWithSecret });
        const { req, res } = createMockReqRes({
            headers: { authorization: "Bearer my_secret_token_123" },
            body: {
                event: {
                    type: "INITIAL_PURCHASE",
                    app_user_id: "nonexistent_user_999",
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.processed).toBe(false);
        expect(res.body.reason).toBe("user_not_found");
    });

    it("activates premium when user is found on INITIAL_PURCHASE", async () => {
        const mockUser = {
            userId: "user_test_123",
            isPremium: false,
            save: vi.fn().mockResolvedValue(true),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);

        const router = createWebhookRouter({ env: {} });
        const { req, res } = createMockReqRes({
            body: {
                event: {
                    type: "INITIAL_PURCHASE",
                    app_user_id: "user_test_123",
                    entitlement_id: "premium",
                    expiration_at_ms: Date.now() + 86400000,
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.processed).toBe(true);
        expect(res.body.isPremium).toBe(true);
        expect(mockUser.isPremium).toBe(true);
        expect(mockUser.premiumEntitlement).toBe("premium");
        expect(mockUser.save).toHaveBeenCalled();
    });

    it("expires subscription on EXPIRATION event", async () => {
        const mockUser = {
            userId: "user_test_123",
            isPremium: true,
            save: vi.fn().mockResolvedValue(true),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);

        const router = createWebhookRouter({ env: {} });
        const { req, res } = createMockReqRes({
            body: {
                event: {
                    type: "EXPIRATION",
                    app_user_id: "user_test_123",
                    entitlement_id: "premium",
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.isPremium).toBe(false);
        expect(mockUser.isPremium).toBe(false);
        expect(mockUser.save).toHaveBeenCalled();
    });

    it("does not grant premium for an unrelated entitlement", async () => {
        const mockUser = {
            userId: "user_test_123",
            isPremium: false,
            save: vi.fn().mockResolvedValue(true),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);

        const router = createWebhookRouter({ env: { REVENUECAT_ENTITLEMENT_ID: "premium" } });
        const { req, res } = createMockReqRes({
            body: {
                event: {
                    type: "INITIAL_PURCHASE",
                    app_user_id: "user_test_123",
                    entitlement_id: "gems_pack",
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.body.processed).toBe(false);
        expect(res.body.reason).toBe("unmanaged_entitlement");
        expect(mockUser.isPremium).toBe(false);
        expect(mockUser.save).not.toHaveBeenCalled();
    });

    it("fails closed in production when webhook authorization is missing", async () => {
        const router = createWebhookRouter({ env: { NODE_ENV: "production" } });
        const { req, res } = createMockReqRes({
            body: { event: { type: "INITIAL_PURCHASE" } },
        });

        const error = await invokeRouter(router, req, res);

        expect(error).toBeDefined();
        expect(error.status).toBe(503);
    });

    it("returns 400 if payload does not include event", async () => {
        const router = createWebhookRouter({ env: {} });
        const { req, res } = createMockReqRes({
            body: {},
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it("returns 200 with missing_app_user_id when app_user_id is missing", async () => {
        const router = createWebhookRouter({ env: {} });
        const { req, res } = createMockReqRes({
            body: {
                event: {
                    type: "INITIAL_PURCHASE",
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.processed).toBe(false);
        expect(res.body.reason).toBe("missing_app_user_id");
    });

    it("records full analytics transaction in SubscriptionTransactionModel on INITIAL_PURCHASE", async () => {
        const mockUser = {
            userId: "user_test_analytics",
            revenueCatAppUserId: "rc_user_uuid",
            isPremium: false,
            save: vi.fn().mockResolvedValue(true),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);
        vi.spyOn(RevenueCatEventModel, "create").mockResolvedValue({});
        const transactionCreateSpy = vi.spyOn(SubscriptionTransactionModel, "create").mockResolvedValue({});

        const router = createWebhookRouter({ env: {} });
        const { req, res } = createMockReqRes({
            body: {
                event: {
                    id: "rc_event_analytics_123",
                    type: "INITIAL_PURCHASE",
                    app_user_id: "rc_user_uuid",
                    entitlement_id: "premium",
                    product_id: "lofn_monthly_1999",
                    price_in_purchased_currency: 1999,
                    currency: "INR",
                    store: "PLAY_STORE",
                    environment: "PRODUCTION",
                    country_code: "IN",
                    period_type: "NORMAL",
                    renewal_number: 1,
                    is_trial_conversion: false,
                    purchased_at_ms: 1773550000000,
                    expiration_at_ms: 1776142000000,
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.processed).toBe(true);
        expect(transactionCreateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user_test_analytics",
                revenueCatAppUserId: "rc_user_uuid",
                eventId: "rc_event_analytics_123",
                eventType: "INITIAL_PURCHASE",
                productId: "lofn_monthly_1999",
                price: 1999,
                currency: "INR",
                store: "PLAY_STORE",
                environment: "PRODUCTION",
                countryCode: "IN",
                periodType: "NORMAL",
                renewalNumber: 1,
                isTrialConversion: false,
            })
        );
    });

    it("records cancellation reason in SubscriptionTransactionModel on CANCELLATION", async () => {
        const mockUser = {
            userId: "user_test_churn",
            revenueCatAppUserId: "rc_user_churn",
            isPremium: true,
            save: vi.fn().mockResolvedValue(true),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);
        vi.spyOn(RevenueCatEventModel, "create").mockResolvedValue({});
        const transactionCreateSpy = vi.spyOn(SubscriptionTransactionModel, "create").mockResolvedValue({});

        const router = createWebhookRouter({ env: {} });
        const { req, res } = createMockReqRes({
            body: {
                event: {
                    id: "rc_event_cancel_456",
                    type: "CANCELLATION",
                    app_user_id: "rc_user_churn",
                    entitlement_id: "premium",
                    product_id: "lofn_monthly_1999",
                    cancel_reason: "UNSUBSCRIBE",
                    store: "APP_STORE",
                    environment: "PRODUCTION",
                    country_code: "US",
                    expiration_at_ms: Date.now() + 86400000,
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(transactionCreateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user_test_churn",
                eventId: "rc_event_cancel_456",
                eventType: "CANCELLATION",
                cancelReason: "UNSUBSCRIBE",
                store: "APP_STORE",
            })
        );
    });
});
