import { UserModel } from "../models/user.model.js";
import { CurrencyService } from "./currency.service.js";

export const DEFAULT_WELCOME_HEARTS = 100;
export const WELCOME_HEARTS_WINDOW_MS = 48 * 60 * 60 * 1000;

export function resolveWelcomeHearts(env) {
    const n = Number(env?.WELCOME_HEARTS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WELCOME_HEARTS;
}

function revenueCatCustomerId(user, fallbackUserId) {
    return user?.revenueCatAppUserId || user?.accountId || fallbackUserId;
}

function onboardedRecently(onboardedAt, now = Date.now()) {
    const stamp = new Date(onboardedAt).getTime();
    return Number.isFinite(stamp) && now - stamp <= WELCOME_HEARTS_WINDOW_MS;
}

function creditLanded(result, starting, amount) {
    const balance = Number(result?.balance);
    if (!Number.isFinite(balance) || balance < 0) return null;
    if (Array.isArray(result.items) && result.items.length === 0 && balance === 0) {
        return null;
    }
    if (balance < starting + amount && balance < amount) return null;
    return balance;
}

async function creditWelcomeHearts(currencyService, customerId, amount, userId) {
    const before = await currencyService.getBalances(customerId);
    const starting = Number(before?.GEMS) || 0;
    const keys = [`welcome-hearts-${userId}`, `welcome-hearts-${userId}-retry`];

    for (const key of keys) {
        const result = await currencyService.adjustBalance(customerId, amount, "GEMS", key);
        let remaining = creditLanded(result, starting, amount);
        if (remaining == null) {
            const confirmed = await currencyService.getBalances(customerId);
            remaining = creditLanded(
                { balance: confirmed.GEMS, items: confirmed.items },
                starting,
                amount,
            );
        }
        if (remaining != null) return remaining;
    }

    throw new Error("Welcome hearts credit did not land");
}

export async function grantWelcomeHeartsIfEligible({ userId, env } = {}) {
    const amount = resolveWelcomeHearts(env);
    if (!userId) {
        return { granted: false, alreadyGranted: false, amount: 0, remainingGems: null };
    }

    const existing = await UserModel.findOne({ userId }).lean();
    if (!existing?.onboardedAt) {
        return { granted: false, alreadyGranted: false, amount: 0, remainingGems: null };
    }
    if (existing.welcomeHeartsGrantedAt) {
        return { granted: false, alreadyGranted: true, amount: 0, remainingGems: null };
    }
    if (!onboardedRecently(existing.onboardedAt)) {
        return { granted: false, alreadyGranted: true, amount: 0, remainingGems: null };
    }

    const currencyService = new CurrencyService(env);
    if (!currencyService.isConfigured()) {
        return { granted: false, alreadyGranted: false, amount: 0, remainingGems: null };
    }

    const remainingGems = await creditWelcomeHearts(
        currencyService,
        revenueCatCustomerId(existing, userId),
        amount,
        userId,
    );

    await UserModel.findOneAndUpdate(
        {
            userId,
            $or: [
                { welcomeHeartsGrantedAt: { $exists: false } },
                { welcomeHeartsGrantedAt: null },
            ],
        },
        { $set: { welcomeHeartsGrantedAt: new Date() } },
    );

    return {
        granted: true,
        alreadyGranted: false,
        amount,
        remainingGems,
    };
}
