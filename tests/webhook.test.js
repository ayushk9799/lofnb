import { describe, expect, it, vi, beforeEach } from "vitest";
import { createWebhookRouter } from "../src/routes/webhook.routes.js";
import { UserModel } from "../src/models/user.model.js";

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
                    entitlement_id: "gold",
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
        expect(mockUser.premiumEntitlement).toBe("gold");
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
                },
            },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.isPremium).toBe(false);
        expect(mockUser.isPremium).toBe(false);
        expect(mockUser.save).toHaveBeenCalled();
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
});
