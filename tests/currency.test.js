import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CurrencyService } from "../src/services/currency.service.js";
import { createCurrencyRouter } from "../src/routes/currency.routes.js";
import { UserModel } from "../src/models/user.model.js";

function createMockReqRes({ method = "GET", url = "/", headers = {}, body = {}, query = {}, auth = { userId: "user_test_123" } } = {}) {
    const req = {
        method,
        url,
        headers,
        header(name) {
            return headers[name.toLowerCase()];
        },
        body,
        query,
        auth,
    };

    let statusCode = 200;
    let jsonBody = null;

    const res = {
        status(code) {
            statusCode = code;
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

describe("CurrencyService", () => {
    const mockEnv = {
        REVENUECAT_PROJECT_ID: "proj_test_123",
        REVENUECAT_SECRET_KEY: "sk_test_secret_key",
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("identifies when properly configured", () => {
        const service = new CurrencyService(mockEnv);
        expect(service.isConfigured()).toBe(true);

        const unconfigured = new CurrencyService({});
        expect(unconfigured.isConfigured()).toBe(false);
    });

    it("fetches user balances correctly from RevenueCat API", async () => {
        const service = new CurrencyService(mockEnv);

        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [
                    { currency_code: "GEMS", balance: 950 },
                ],
            }),
        });

        const balances = await service.getBalances("user_123");
        expect(balances.GEMS).toBe(950);
        expect(global.fetch).toHaveBeenCalledWith(
            "https://api.revenuecat.com/v2/projects/proj_test_123/customers/user_123/virtual_currencies",
            expect.objectContaining({
                headers: {
                    Authorization: "Bearer sk_test_secret_key",
                },
            })
        );
    });

    it("verifies an active entitlement directly with RevenueCat", async () => {
        const service = new CurrencyService(mockEnv);

        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                subscriber: {
                    entitlements: {
                        premium: { expires_date: "2099-01-01T00:00:00Z" },
                    },
                },
            }),
        });

        await expect(service.hasActiveEntitlement("rc_user_uuid", "premium")).resolves.toBe(true);
        expect(global.fetch).toHaveBeenCalledWith(
            "https://api.revenuecat.com/v1/subscribers/rc_user_uuid",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer sk_test_secret_key",
                }),
            })
        );
    });

    it("adjusts balance (spending) via RevenueCat transaction API", async () => {
        const service = new CurrencyService(mockEnv);

        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [
                    { currency_code: "GEMS", balance: 945 },
                ],
            }),
        });

        const result = await service.adjustBalance("user_123", -5, "GEMS", "test-idempotency-key");
        expect(result.success).toBe(true);
        expect(result.balance).toBe(945);

        expect(global.fetch).toHaveBeenCalledWith(
            "https://api.revenuecat.com/v2/projects/proj_test_123/customers/user_123/virtual_currencies/transactions",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    "Idempotency-Key": "test-idempotency-key",
                    Authorization: "Bearer sk_test_secret_key",
                }),
                body: JSON.stringify({
                    adjustments: {
                        GEMS: -5,
                    },
                }),
            })
        );
    });

    it("throws 422 error when user has insufficient balance", async () => {
        const service = new CurrencyService(mockEnv);

        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 422,
            json: async () => ({
                message: "Customer's balance is not enough to perform the transaction.",
            }),
        });

        await expect(service.adjustBalance("user_123", -1000)).rejects.toThrow(
            "Customer's balance is not enough to perform the transaction."
        );
    });
});

describe("Currency Routes", () => {
    const mockEnv = {
        REVENUECAT_PROJECT_ID: "proj_test_123",
        REVENUECAT_SECRET_KEY: "sk_test_secret_key",
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("GET / returns the user gems balance", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue({
                userId: "user_test_123",
                revenueCatAppUserId: "rc_user_uuid",
            }),
        });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [{ currency_code: "GEMS", balance: 120 }],
            }),
        });

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "GET", url: "/" });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            gems: 120,
            items: [{ currency_code: "GEMS", balance: 120 }],
        });
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("/customers/rc_user_uuid/virtual_currencies"),
            expect.any(Object)
        );
    });

    it("POST /spend spends gems and returns updated balance", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue({
                userId: "user_test_123",
                revenueCatAppUserId: "rc_user_uuid",
            }),
        });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [{ currency_code: "GEMS", balance: 115 }],
            }),
        });

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({
            method: "POST",
            url: "/spend",
            body: { amount: 5 },
        });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            spent: 5,
            remainingGems: 115,
        });
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("/customers/rc_user_uuid/virtual_currencies/transactions"),
            expect.any(Object)
        );
    });

    it("POST /spend rejects invalid amount", async () => {
        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({
            method: "POST",
            url: "/spend",
            body: { amount: -10 },
        });

        const err = await invokeRouter(router, req, res);
        expect(err).toBeTruthy();
        expect(err.status).toBe(400);
    });

    it("GET /daily-reward returns canClaim: true when never claimed", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue({
                userId: "user_test_123",
                lastDailyHeartsClaimedAt: null,
                isPremium: false,
            }),
        });

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "GET", url: "/daily-reward" });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.canClaim).toBe(true);
        expect(res.body.amount).toBe(10);
        expect(res.body.cooldownSeconds).toBe(0);
    });

    it("GET /daily-reward returns canClaim: false with cooldown when claimed recently", async () => {
        const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue({
                userId: "user_test_123",
                lastDailyHeartsClaimedAt: fiveHoursAgo,
                isPremium: false,
            }),
        });

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "GET", url: "/daily-reward" });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.canClaim).toBe(false);
        expect(res.body.cooldownSeconds).toBeGreaterThan(0);
        expect(res.body.nextClaimAvailableAt).toBeTruthy();
    });

    it("POST /daily-reward/claim claims 10 hearts and updates user timestamp", async () => {
        const mockSave = vi.fn().mockResolvedValue(true);
        const mockUser = {
            userId: "user_test_123",
            lastDailyHeartsClaimedAt: null,
            isPremium: false,
            save: mockSave,
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);

        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [{ currency_code: "GEMS", balance: 130 }],
            }),
        });

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "POST", url: "/daily-reward/claim" });

        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.claimed).toBe(10);
        expect(res.body.remainingGems).toBe(130);
        expect(mockSave).toHaveBeenCalled();
        expect(mockUser.lastDailyHeartsClaimedAt).toBeTruthy();
    });

    it("POST /daily-reward/claim verifies delayed premium state and credits the RevenueCat ID", async () => {
        const mockSave = vi.fn().mockResolvedValue(true);
        const mockUser = {
            userId: "user_test_123",
            revenueCatAppUserId: "rc_user_uuid",
            lastDailyHeartsClaimedAt: null,
            isPremium: false,
            save: mockSave,
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);

        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    subscriber: {
                        entitlements: {
                            premium: { expires_date: "2099-01-01T00:00:00Z" },
                        },
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    items: [{ currency_code: "GEMS", balance: 150 }],
                }),
            });

        const router = createCurrencyRouter({
            env: { ...mockEnv, REVENUECAT_ENTITLEMENT_ID: "premium" },
        });
        const { req, res } = createMockReqRes({
            method: "POST",
            url: "/daily-reward/claim",
            body: { premiumExpected: true },
        });

        await invokeRouter(router, req, res);

        expect(res.body.claimed).toBe(30);
        expect(res.body.remainingGems).toBe(150);
        expect(mockUser.isPremium).toBe(true);
        expect(mockSave).toHaveBeenCalled();
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining("/customers/rc_user_uuid/virtual_currencies/transactions"),
            expect.any(Object)
        );
    });

    it("POST /daily-reward/claim rejects when still in cooldown", async () => {
        const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
        const mockUser = {
            userId: "user_test_123",
            lastDailyHeartsClaimedAt: tenMinsAgo,
            isPremium: false,
            save: vi.fn(),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "POST", url: "/daily-reward/claim" });

        const err = await invokeRouter(router, req, res);

        expect(err).toBeTruthy();
        expect(err.status).toBe(400);
        expect(err.code).toBe("COOLDOWN_ACTIVE");
    });

    it("allows repeat claims with unique RevenueCat transactions when test cooldown is zero", async () => {
        const mockUser = {
            userId: "user_test_123",
            revenueCatAppUserId: "rc_user_uuid",
            lastDailyHeartsClaimedAt: new Date(),
            isPremium: false,
            save: vi.fn().mockResolvedValue(true),
        };
        vi.spyOn(UserModel, "findOne").mockResolvedValue(mockUser);
        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [{ currency_code: "GEMS", balance: 10 }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [{ currency_code: "GEMS", balance: 20 }] }),
            });

        const router = createCurrencyRouter({
            env: { ...mockEnv, DAILY_REWARD_COOLDOWN_SECONDS: 0 },
        });
        const first = createMockReqRes({ method: "POST", url: "/daily-reward/claim" });
        const second = createMockReqRes({ method: "POST", url: "/daily-reward/claim" });

        await invokeRouter(router, first.req, first.res);
        await invokeRouter(router, second.req, second.res);

        expect(first.res.body).toMatchObject({ claimed: 10, remainingGems: 10, cooldownSeconds: 0 });
        expect(second.res.body).toMatchObject({ claimed: 10, remainingGems: 20, cooldownSeconds: 0 });
        expect(first.res.body.nextClaimAvailableAt).toBeNull();
        const firstKey = global.fetch.mock.calls[0][1].headers["Idempotency-Key"];
        const secondKey = global.fetch.mock.calls[1][1].headers["Idempotency-Key"];
        expect(firstKey).not.toBe(secondKey);
    });

    it("POST /welcome grants 100 hearts once after first onboarding", async () => {
        const user = {
            userId: "user_test_123",
            onboardedAt: new Date(),
            welcomeHeartsGrantedAt: null,
            revenueCatAppUserId: "rc_user_uuid",
        };
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue(user),
        });
        vi.spyOn(UserModel, "findOneAndUpdate").mockResolvedValue({
            ...user,
            welcomeHeartsGrantedAt: new Date(),
        });

        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [{ currency_code: "GEMS", balance: 100 }] }),
            });

        const router = createCurrencyRouter({ env: { ...mockEnv, WELCOME_HEARTS: 100 } });
        const { req, res } = createMockReqRes({ method: "POST", url: "/welcome" });
        await invokeRouter(router, req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            claimed: 100,
            alreadyGranted: false,
            remainingGems: 100,
        });
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("/customers/rc_user_uuid/virtual_currencies/transactions"),
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    "Idempotency-Key": "welcome-hearts-rc_user_uuid",
                }),
            }),
        );
    });

    it("POST /welcome is a no-op if welcome hearts were already granted", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue({
                userId: "user_test_123",
                onboardedAt: new Date(),
                welcomeHeartsGrantedAt: new Date(),
            }),
        });
        const updateSpy = vi.spyOn(UserModel, "findOneAndUpdate");
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ items: [{ currency_code: "GEMS", balance: 100 }] }),
        });

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "POST", url: "/welcome" });
        await invokeRouter(router, req, res);

        expect(res.body).toMatchObject({ claimed: 0, alreadyGranted: true, remainingGems: 100 });
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it("POST /welcome does not grant before onboarding is complete", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue({
                userId: "user_test_123",
                onboardedAt: null,
                welcomeHeartsGrantedAt: null,
            }),
        });
        global.fetch = vi.fn();

        const router = createCurrencyRouter({ env: mockEnv });
        const { req, res } = createMockReqRes({ method: "POST", url: "/welcome" });
        await invokeRouter(router, req, res);

        expect(res.body).toMatchObject({ claimed: 0, alreadyGranted: false });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
