import { describe, expect, it, vi, beforeEach } from "vitest";
import { UserModel } from "../src/models/user.model.js";
import {
    grantWelcomeHeartsIfEligible,
    WELCOME_HEARTS_WINDOW_MS,
} from "../src/services/welcome-hearts.service.js";

const env = {
    REVENUECAT_PROJECT_ID: "proj_test_123",
    REVENUECAT_SECRET_KEY: "sk_test_secret_key",
    WELCOME_HEARTS: 100,
};

function onboardedUser(overrides = {}) {
    return {
        userId: "new-user",
        onboardedAt: new Date(),
        welcomeHeartsGrantedAt: null,
        revenueCatAppUserId: "rc_new",
        ...overrides,
    };
}

describe("grantWelcomeHeartsIfEligible", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("skips long-time users whose onboarding is outside the welcome window", async () => {
        const oldOnboard = new Date(Date.now() - WELCOME_HEARTS_WINDOW_MS - 60_000);
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue(onboardedUser({
                userId: "old-user",
                onboardedAt: oldOnboard,
            })),
        });
        const updateSpy = vi.spyOn(UserModel, "findOneAndUpdate");

        const result = await grantWelcomeHeartsIfEligible({ userId: "old-user", env });
        expect(result).toEqual({
            granted: false,
            alreadyGranted: true,
            amount: 0,
            remainingGems: null,
        });
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it("does not lock the grant if RevenueCat credit fails", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue(onboardedUser()),
        });
        const updateSpy = vi.spyOn(UserModel, "findOneAndUpdate");
        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [] }),
            })
            .mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({ message: "RevenueCat down" }),
            });

        await expect(
            grantWelcomeHeartsIfEligible({ userId: "new-user", env }),
        ).rejects.toThrow();
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it("retries when the first RevenueCat response credits nothing", async () => {
        vi.spyOn(UserModel, "findOne").mockReturnValue({
            lean: vi.fn().mockResolvedValue(onboardedUser()),
        });
        const updateSpy = vi.spyOn(UserModel, "findOneAndUpdate").mockResolvedValue({});
        global.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    items: [{ currency_code: "GEMS", balance: 100 }],
                }),
            });

        const result = await grantWelcomeHeartsIfEligible({ userId: "new-user", env });
        expect(result).toEqual({
            granted: true,
            alreadyGranted: false,
            amount: 100,
            remainingGems: 100,
        });
        expect(updateSpy).toHaveBeenCalled();
        const retryKey = global.fetch.mock.calls[3][1].headers["Idempotency-Key"];
        expect(retryKey).toBe("welcome-hearts-new-user-retry");
    });
});
