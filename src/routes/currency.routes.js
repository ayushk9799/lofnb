import { Router } from "express";
import { HttpError } from "../utils/http-error.js";
import { CurrencyService } from "../services/currency.service.js";
import { UserModel } from "../models/user.model.js";

const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function createCurrencyRouter({ env }) {
    const router = Router();
    const currencyService = new CurrencyService(env);

    // GET /api/gems/daily-reward - Get status of daily hearts reward
    router.get("/daily-reward", async (request, response) => {
        const userId = request.auth?.userId;
        if (!userId) {
            throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
        }

        const user = await UserModel.findOne({ userId }).lean();
        const lastClaimedAt = user?.lastDailyHeartsClaimedAt ? new Date(user.lastDailyHeartsClaimedAt) : null;
        const now = Date.now();

        let cooldownSeconds = 0;
        let canClaim = true;
        let nextClaimAvailableAt = null;

        if (lastClaimedAt) {
            const nextTime = lastClaimedAt.getTime() + DAILY_COOLDOWN_MS;
            if (nextTime > now) {
                canClaim = false;
                cooldownSeconds = Math.ceil((nextTime - now) / 1000);
                nextClaimAvailableAt = new Date(nextTime).toISOString();
            }
        }

        const isPremium = Boolean(user?.isPremium);
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
            const nextTime = user.lastDailyHeartsClaimedAt.getTime() + DAILY_COOLDOWN_MS;
            if (nextTime > now) {
                throw new HttpError(400, "Daily hearts reward is on cooldown.", "COOLDOWN_ACTIVE");
            }
        }

        const isPremium = Boolean(user.isPremium);
        const amount = isPremium ? 30 : 10;
        const idempotencyKey = request.header("Idempotency-Key") || `daily-hearts-${userId}-${new Date(now).toISOString().slice(0, 10)}`;

        const result = await currencyService.adjustBalance(userId, amount, "GEMS", idempotencyKey);

        user.lastDailyHeartsClaimedAt = new Date(now);
        await user.save();

        const nextClaimAvailableAt = new Date(now + DAILY_COOLDOWN_MS).toISOString();

        const claimPayload = {
            success: true,
            claimed: amount,
            remainingGems: result.balance,
            nextClaimAvailableAt,
            cooldownSeconds: Math.ceil(DAILY_COOLDOWN_MS / 1000),
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

        const balances = await currencyService.getBalances(userId);
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
        const result = await currencyService.adjustBalance(userId, -Math.abs(amount), "GEMS", idempotencyKey);

        return response.json({
            success: true,
            spent: amount,
            remainingGems: result.balance,
        });
    });

    return router;
}
