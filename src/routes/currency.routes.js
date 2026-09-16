import { Router } from "express";
import { randomUUID } from "node:crypto";
import { HttpError } from "../utils/http-error.js";
import { CurrencyService } from "../services/currency.service.js";
import { UserModel } from "../models/user.model.js";

const DEFAULT_DAILY_COOLDOWN_SECONDS = 24 * 60 * 60;

function revenueCatCustomerId(user, fallbackUserId) {
    return user?.revenueCatAppUserId || user?.accountId || fallbackUserId;
}

export function createCurrencyRouter({ env }) {
    const router = Router();
    const currencyService = new CurrencyService(env);
    const configuredCooldown = Number(env?.DAILY_REWARD_COOLDOWN_SECONDS);
    const dailyCooldownSeconds = Number.isFinite(configuredCooldown)
        ? Math.max(0, Math.floor(configuredCooldown))
        : DEFAULT_DAILY_COOLDOWN_SECONDS;
    const dailyCooldownMs = dailyCooldownSeconds * 1000;

    // GET /api/gems/daily-reward - Get status of daily hearts reward
    router.get("/daily-reward", async (request, response) => {
        const userId = request.auth?.userId;
        if (!userId) {
            throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
        }

        const user = await UserModel.findOne({ userId }).lean();
        if (!user) {
            throw new HttpError(404, "User not found", "USER_NOT_FOUND");
        }
        const lastClaimedAt = user?.lastDailyHeartsClaimedAt ? new Date(user.lastDailyHeartsClaimedAt) : null;
        const now = Date.now();

        let cooldownSeconds = 0;
        let canClaim = true;
        let nextClaimAvailableAt = null;

        if (lastClaimedAt) {
            const nextTime = lastClaimedAt.getTime() + dailyCooldownMs;
            if (nextTime > now) {
                canClaim = false;
                cooldownSeconds = Math.ceil((nextTime - now) / 1000);
                nextClaimAvailableAt = new Date(nextTime).toISOString();
            }
        }

        let isPremium = Boolean(user.isPremium);
        const shouldRefreshPremium = request.query?.refreshPremium === "true";
        if (!isPremium && shouldRefreshPremium) {
            isPremium = await currencyService.hasActiveEntitlement(
                revenueCatCustomerId(user, userId),
                env?.REVENUECAT_ENTITLEMENT_ID || "premium"
            );
            if (!isPremium) {
                throw new HttpError(
                    409,
                    "Your premium membership is still syncing. Please try again shortly.",
                    "PREMIUM_STATUS_PENDING"
                );
            }
        }
        const amount = isPremium ? 30 : 10;

        const payload = {
            success: true,
            canClaim,
            amount,
            cooldownSeconds,
            lastClaimedAt: lastClaimedAt ? lastClaimedAt.toISOString() : null,
            nextClaimAvailableAt,
            isPremium,
        };

        return response.json({
            ...payload,
            data: payload,
        });
    });

    // POST /api/gems/daily-reward/claim - Claim daily hearts reward
    router.post("/daily-reward/claim", async (request, response) => {
        const userId = request.auth?.userId;
        if (!userId) {
            throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
        }

        const user = await UserModel.findOne({ userId });
        if (!user) {
            throw new HttpError(404, "User not found", "USER_NOT_FOUND");
        }

        const now = Date.now();
        if (user.lastDailyHeartsClaimedAt) {
            const nextTime = user.lastDailyHeartsClaimedAt.getTime() + dailyCooldownMs;
            if (nextTime > now) {
                throw new HttpError(400, "Daily hearts reward is on cooldown.", "COOLDOWN_ACTIVE");
            }
        }

        let isPremium = Boolean(user.isPremium);
        const premiumExpected = request.body?.premiumExpected === true;
        if (!isPremium && premiumExpected) {
            isPremium = await currencyService.hasActiveEntitlement(
                revenueCatCustomerId(user, userId),
                env?.REVENUECAT_ENTITLEMENT_ID || "premium"
            );
            if (!isPremium) {
                throw new HttpError(
                    409,
                    "Your premium membership is still syncing. Please try again shortly.",
                    "PREMIUM_STATUS_PENDING"
                );
            }
            // Keep the local fallback in sync when the webhook is delayed.
            user.isPremium = true;
            user.premiumEntitlement = env?.REVENUECAT_ENTITLEMENT_ID || "premium";
        }
        const amount = isPremium ? 30 : 10;
        const defaultIdempotencyKey = dailyCooldownSeconds === 0
            ? `daily-hearts-test-${userId}-${randomUUID()}`
            : `daily-hearts-${userId}-${new Date(now).toISOString().slice(0, 10)}`;
        const idempotencyKey = request.header("Idempotency-Key") || defaultIdempotencyKey;

        const result = await currencyService.adjustBalance(
            revenueCatCustomerId(user, userId),
            amount,
            "GEMS",
            idempotencyKey
        );

        user.lastDailyHeartsClaimedAt = new Date(now);
        await user.save();

        const nextClaimAvailableAt = dailyCooldownSeconds > 0
            ? new Date(now + dailyCooldownMs).toISOString()
            : null;

        const claimPayload = {
            success: true,
            claimed: amount,
            remainingGems: result.balance,
            nextClaimAvailableAt,
            cooldownSeconds: dailyCooldownSeconds,
        };

        return response.json({
            ...claimPayload,
            data: claimPayload,
        });
    });

    // GET /api/gems - Get current user gems balance
    router.get("/", async (request, response) => {
        const userId = request.auth?.userId;
        if (!userId) {
            throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
        }

        const user = await UserModel.findOne({ userId }).lean();
        if (!user) {
            throw new HttpError(404, "User not found", "USER_NOT_FOUND");
        }
        const balances = await currencyService.getBalances(revenueCatCustomerId(user, userId));
        return response.json({
            success: true,
            gems: balances.GEMS,
            items: balances.items,
        });
    });

    // POST /api/gems/spend - Spend gems for an action
    router.post("/spend", async (request, response) => {
        const userId = request.auth?.userId;
        if (!userId) {
            throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
        }

        const rawAmount = request.body?.amount;
        const amount = Number(rawAmount);
        if (!amount || amount <= 0) {
            throw new HttpError(400, "Amount must be a positive number", "INVALID_AMOUNT");
        }

        const idempotencyKey = request.header("Idempotency-Key") || undefined;
        const user = await UserModel.findOne({ userId }).lean();
        if (!user) {
            throw new HttpError(404, "User not found", "USER_NOT_FOUND");
        }
        const result = await currencyService.adjustBalance(
            revenueCatCustomerId(user, userId),
            -Math.abs(amount),
            "GEMS",
            idempotencyKey
        );

        return response.json({
            success: true,
            spent: amount,
            remainingGems: result.balance,
        });
    });

    return router;
}
