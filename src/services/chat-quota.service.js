import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { UserModel } from "../models/user.model.js";
import { CurrencyService } from "./currency.service.js";
import { HttpError } from "../utils/http-error.js";

export const DEFAULT_FREE_MESSAGES_PER_COMPANION = 10;
export const DEFAULT_COMPANION_OFFLINE_MINUTES = 480;

export function resolveFreeMessageLimit(env) {
    const n = Number(env?.FREE_MESSAGES_PER_COMPANION);
    return Number.isFinite(n) && n > 0
        ? Math.floor(n)
        : DEFAULT_FREE_MESSAGES_PER_COMPANION;
}

export function resolveCompanionOfflineMinutes(env) {
    const minutes = Number(env?.COMPANION_OFFLINE_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
    const hours = Number(env?.COMPANION_OFFLINE_HOURS);
    if (Number.isFinite(hours) && hours > 0) return hours * 60;
    return DEFAULT_COMPANION_OFFLINE_MINUTES;
}

export function resolveCompanionOfflineMs(env) {
    return Math.round(resolveCompanionOfflineMinutes(env) * 60 * 1000);
}

export function isPremiumActive(user, env) {
    if (env?.DISABLE_CHAT_QUOTA === "true") return true;
    if (user?.userId && (user.userId.startsWith("web_tester_") || user.userId === "dev_user")) return true;
    if (!user?.isPremium) return false;
    if (!user.premiumExpiresAt) return true;
    const expiresAt = new Date(user.premiumExpiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return true;
    return expiresAt > Date.now();
}

function toIso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function userMessageFilter(relationshipId, windowStart) {
    const filter = { relationshipId, role: "user" };
    if (windowStart) filter.createdAt = { $gte: new Date(windowStart) };
    return filter;
}

function revenueCatCustomerId(user) {
    return user?.revenueCatAppUserId || user?.accountId || user?.userId;
}

async function syncPremiumFromRevenueCat(user, env) {
    if (!user || isPremiumActive(user)) return user;
    const service = new CurrencyService(env);
    if (!service.isConfigured()) return user;
    try {
        const live = await service.getActiveEntitlement(
            revenueCatCustomerId(user),
            env?.REVENUECAT_ENTITLEMENT_ID || "premium",
        );
        if (!live.isActive) return user;
        const premiumEntitlement = env?.REVENUECAT_ENTITLEMENT_ID || "premium";
        const update = {
            $set: {
                isPremium: true,
                premiumEntitlement,
                ...(live.expiresAt ? { premiumExpiresAt: live.expiresAt } : {}),
            },
            ...(live.expiresAt ? {} : { $unset: { premiumExpiresAt: 1 } }),
        };
        await UserModel.updateOne({ userId: user.userId }, update);
        return {
            ...user,
            isPremium: true,
            premiumEntitlement,
            premiumExpiresAt: live.expiresAt || undefined,
        };
    } catch {
        return user;
    }
}

async function expireOfflineWindowIfNeeded(rel, now) {
    if (!rel?.companionOfflineUntil) return rel;
    const untilMs = new Date(rel.companionOfflineUntil).getTime();
    if (!Number.isFinite(untilMs) || untilMs > now) return rel;
    const until = rel.companionOfflineUntil;
    const windowStart = new Date(now);
    await RelationshipModel.updateOne(
        { _id: rel._id, companionOfflineUntil: until },
        {
            $set: { freeMessageWindowStart: windowStart },
            $unset: { companionOfflineUntil: 1 },
        },
    );
    return {
        ...rel,
        freeMessageWindowStart: windowStart,
        companionOfflineUntil: undefined,
    };
}

async function ensureOfflineUntil(rel, count, limit, env, now) {
    if (!rel || count < limit) return rel;
    if (rel.companionOfflineUntil && new Date(rel.companionOfflineUntil).getTime() > now) {
        return rel;
    }
    const last = await MessageModel.findOne(
        userMessageFilter(rel._id, rel.freeMessageWindowStart),
    )
        .sort({ createdAt: -1 })
        .select("createdAt")
        .lean();
    const startMs = last?.createdAt ? new Date(last.createdAt).getTime() : now;
    const until = new Date(startMs + resolveCompanionOfflineMs(env));
    if (until.getTime() <= now) {
        return expireOfflineWindowIfNeeded({ ...rel, companionOfflineUntil: until }, now);
    }
    await RelationshipModel.updateOne(
        {
            _id: rel._id,
            $or: [
                { companionOfflineUntil: { $exists: false } },
                { companionOfflineUntil: null },
            ],
        },
        { $set: { companionOfflineUntil: until } },
    );
    return { ...rel, companionOfflineUntil: until };
}

function quotaMeta(env, extra = {}) {
    return {
        freeMessageLimit: resolveFreeMessageLimit(env),
        companionOfflineMinutes: resolveCompanionOfflineMinutes(env),
        ...extra,
    };
}

function premiumAvailability(env) {
    return quotaMeta(env, {
        companionOffline: false,
        companionOfflineUntil: null,
        isPremium: true,
    });
}

export async function resolveRelationshipAvailability(rel, {
    user,
    env,
    now = Date.now(),
} = {}) {
    if (env?.DISABLE_CHAT_QUOTA === "true" || (user?.userId && (user.userId.startsWith("web_tester_") || user.userId === "dev_user"))) {
        return premiumAvailability(env);
    }
    const freeMessageLimit = resolveFreeMessageLimit(env);
    if (!rel?._id) {
        return quotaMeta(env, {
            companionOffline: false,
            companionOfflineUntil: null,
            isPremium: isPremiumActive(user, env),
        });
    }
    if (isPremiumActive(user, env)) return premiumAvailability(env);

    let current = await expireOfflineWindowIfNeeded(rel, now);
    const count = await MessageModel.countDocuments(
        userMessageFilter(current._id, current.freeMessageWindowStart),
    );
    if (count < freeMessageLimit) {
        return quotaMeta(env, {
            companionOffline: false,
            companionOfflineUntil: null,
            userMessageCount: count,
            isPremium: false,
        });
    }

    const synced = await syncPremiumFromRevenueCat(user, env);
    if (isPremiumActive(synced)) return premiumAvailability(env);

    current = await ensureOfflineUntil(current, count, freeMessageLimit, env, now);
    if (!current.companionOfflineUntil) {
        current = await expireOfflineWindowIfNeeded(current, now);
        const freshCount = await MessageModel.countDocuments(
            userMessageFilter(current._id, current.freeMessageWindowStart),
        );
        return quotaMeta(env, {
            companionOffline: false,
            companionOfflineUntil: null,
            userMessageCount: freshCount,
            isPremium: false,
        });
    }

    const untilMs = new Date(current.companionOfflineUntil).getTime();
    const offline = untilMs > now;
    return quotaMeta(env, {
        companionOffline: offline,
        companionOfflineUntil: offline ? toIso(current.companionOfflineUntil) : null,
        userMessageCount: count,
        isPremium: false,
    });
}

export async function getCompanionAvailability({
    userId,
    relationshipId,
    env,
} = {}) {
    const user = userId
        ? await UserModel.findOne({ userId }).select("userId isPremium premiumExpiresAt revenueCatAppUserId accountId").lean()
        : null;
    const rel = relationshipId
        ? await RelationshipModel.findById(relationshipId)
            .select("companionOfflineUntil freeMessageWindowStart")
            .lean()
        : null;
    return resolveRelationshipAvailability(rel, { user, env });
}

export async function assertCompanionOnline({ userId, relationshipId, env } = {}) {
    if (env?.DISABLE_CHAT_QUOTA === "true" || (userId && (userId.startsWith("web_tester_") || userId === "dev_user"))) {
        return { companionOffline: false, isPremium: true };
    }
    const availability = await getCompanionAvailability({ userId, relationshipId, env });
    if (!availability.companionOffline) return availability;
    throw new HttpError(
        403,
        "This companion is offline. Subscribe to Lofn Gold to keep chatting.",
        "COMPANION_OFFLINE",
    );
}

export async function attachCompanionAvailability(userId, relationships = [], env) {
    const list = Array.isArray(relationships) ? relationships : [];
    const freeMessageLimit = resolveFreeMessageLimit(env);
    const companionOfflineMinutes = resolveCompanionOfflineMinutes(env);
    if (!list.length) return list;

    if (env?.DISABLE_CHAT_QUOTA === "true" || (userId && (userId.startsWith("web_tester_") || userId === "dev_user"))) {
        return list.map((rel) => ({
            ...rel,
            companionOffline: false,
            companionOfflineUntil: null,
            freeMessageLimit,
            companionOfflineMinutes,
        }));
    }

    const user = await UserModel.findOne({ userId }).select("userId isPremium premiumExpiresAt revenueCatAppUserId accountId").lean();
    if (isPremiumActive(user, env)) {
        return list.map((rel) => ({
            ...rel,
            companionOffline: false,
            companionOfflineUntil: null,
            freeMessageLimit,
            companionOfflineMinutes,
        }));
    }

    return Promise.all(list.map(async (rel) => {
        const availability = await resolveRelationshipAvailability(rel, { user, env });
        return {
            ...rel,
            companionOffline: availability.companionOffline,
            companionOfflineUntil: availability.companionOfflineUntil,
            freeMessageLimit: availability.freeMessageLimit,
            companionOfflineMinutes: availability.companionOfflineMinutes,
        };
    }));
}
