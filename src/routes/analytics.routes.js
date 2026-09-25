import { Router } from "express";
import { UserModel } from "../models/user.model.js";
import { SwipeModel } from "../models/swipe.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { CharacterModel } from "../models/character.model.js";

export const analyticsRouter = Router();

// Server-side in-memory cache for ultra-fast response times
const serverCache = new Map();
const CACHE_TTL_MS = 30 * 1000; // 30 seconds TTL

function getServerCached(key, forceFresh = false) {
  if (forceFresh) return null;
  const entry = serverCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    serverCache.delete(key);
    return null;
  }
  return entry.data;
}

function setServerCached(key, data, ttlMs = CACHE_TTL_MS) {
  serverCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

function setResponseCacheHeader(res, cacheStatus) {
  if (typeof res.set === "function") {
    res.set("X-Cache", cacheStatus);
  } else if (typeof res.setHeader === "function") {
    res.setHeader("X-Cache", cacheStatus);
  }
}

// Helper to get start date for N days ago
function getStartDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 30));
  d.setHours(0, 0, 0, 0);
  return d;
}

// 1. Analytics Summary & Trends
analyticsRouter.get("/summary", async (req, res, next) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const forceFresh = req.query.fresh === "true" || req.headers["cache-control"] === "no-cache";
    const cacheKey = `summary:${days}`;

    const cached = getServerCached(cacheKey, forceFresh);
    if (cached) {
      setResponseCacheHeader(res, "HIT");
      return res.json(cached);
    }

    const startDate = getStartDate(days);

    // Parallel aggregate counts
    const [
      totalUsers,
      newUsersInPeriod,
      premiumUsers,
      totalSwipes,
      likesCount,
      passesCount,
      totalMatches,
      totalMessages,
      userMessages,
      assistantMessages,
    ] = await Promise.all([
      UserModel.countDocuments(),
      UserModel.countDocuments({ createdAt: { $gte: startDate } }),
      UserModel.countDocuments({ isPremium: true }),
      SwipeModel.countDocuments(),
      SwipeModel.countDocuments({ direction: "like" }),
      SwipeModel.countDocuments({ direction: "pass" }),
      RelationshipModel.countDocuments(),
      MessageModel.countDocuments(),
      MessageModel.countDocuments({ role: "user" }),
      MessageModel.countDocuments({ role: "assistant" }),
    ]);

    const likeRatio = totalSwipes > 0 ? Number(((likesCount / totalSwipes) * 100).toFixed(1)) : 0;
    const matchRate = likesCount > 0 ? Number(((totalMatches / likesCount) * 100).toFixed(1)) : 0;
    const conversionRate = totalUsers > 0 ? Number(((premiumUsers / totalUsers) * 100).toFixed(1)) : 0;
    const avgMessagesPerMatch = totalMatches > 0 ? Number((totalMessages / totalMatches).toFixed(1)) : 0;

    // Daily Join Trend (last N days)
    const joinTrendRaw = await UserModel.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Daily Swipe Trend (last N days)
    const swipeTrendRaw = await SwipeModel.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          likes: { $sum: { $cond: [{ $eq: ["$direction", "like"] }, 1, 0] } },
          passes: { $sum: { $cond: [{ $eq: ["$direction", "pass"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Daily Match Trend (last N days)
    const matchTrendRaw = await RelationshipModel.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Daily Message Trend (last N days)
    const messageTrendRaw = await MessageModel.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          userCount: { $sum: { $cond: [{ $eq: ["$role", "user"] }, 1, 0] } },
          assistantCount: { $sum: { $cond: [{ $eq: ["$role", "assistant"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Build complete daily timeline so charts have no gaps
    const dateMap = new Map();
    const cur = new Date(startDate);
    const now = new Date();
    while (cur <= now) {
      const dateStr = cur.toISOString().split("T")[0];
      dateMap.set(dateStr, {
        date: dateStr,
        users: 0,
        likes: 0,
        passes: 0,
        swipes: 0,
        matches: 0,
        userMessages: 0,
        assistantMessages: 0,
        messages: 0,
      });
      cur.setDate(cur.getDate() + 1);
    }

    joinTrendRaw.forEach((item) => {
      if (dateMap.has(item._id)) dateMap.get(item._id).users = item.count;
    });

    swipeTrendRaw.forEach((item) => {
      if (dateMap.has(item._id)) {
        const entry = dateMap.get(item._id);
        entry.likes = item.likes;
        entry.passes = item.passes;
        entry.swipes = item.total;
      }
    });

    matchTrendRaw.forEach((item) => {
      if (dateMap.has(item._id)) dateMap.get(item._id).matches = item.count;
    });

    messageTrendRaw.forEach((item) => {
      if (dateMap.has(item._id)) {
        const entry = dateMap.get(item._id);
        entry.userMessages = item.userCount;
        entry.assistantMessages = item.assistantCount;
        entry.messages = item.total;
      }
    });

    const fullTrends = Array.from(dateMap.values());

    const result = {
      totalUsers,
      newUsersInPeriod,
      premiumUsers,
      conversionRate,
      totalSwipes,
      likesCount,
      passesCount,
      likeRatio,
      totalMatches,
      matchRate,
      totalMessages,
      userMessages,
      assistantMessages,
      avgMessagesPerMatch,
      trends: fullTrends,
    };

    setServerCached(cacheKey, result);
    setResponseCacheHeader(res, "MISS");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 2. Paginated User List with Swipes, Matches, and Messages counts
analyticsRouter.get("/users", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 15));
    const search = (req.query.search || "").trim();
    const platform = (req.query.platform || "").trim();
    const isPremium = req.query.isPremium;

    const forceFresh = req.query.fresh === "true" || req.headers["cache-control"] === "no-cache";
    const cacheKey = `users:${page}:${limit}:${search.toLowerCase()}:${platform.toLowerCase()}:${isPremium ?? "all"}`;

    const cached = getServerCached(cacheKey, forceFresh);
    if (cached) {
      setResponseCacheHeader(res, "HIT");
      return res.json(cached);
    }

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { userId: { $regex: search, $options: "i" } },
      ];
    }
    if (platform) {
      filter.platform = platform;
    }
    if (isPremium !== undefined && isPremium !== "") {
      filter.isPremium = isPremium === "true";
    }

    const skip = (page - 1) * limit;
    const [total, users] = await Promise.all([
      UserModel.countDocuments(filter),
      UserModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const userIds = users.map((u) => u.userId);

    // Aggregate swipe counts per user
    const swipeCounts = await SwipeModel.aggregate([
      { $match: { userId: { $in: userIds } } },
      {
        $group: {
          _id: "$userId",
          totalSwipes: { $sum: 1 },
          likes: { $sum: { $cond: [{ $eq: ["$direction", "like"] }, 1, 0] } },
          passes: { $sum: { $cond: [{ $eq: ["$direction", "pass"] }, 1, 0] } },
        },
      },
    ]);
    const swipeMap = new Map(swipeCounts.map((s) => [s._id, s]));

    // Aggregate match counts and relationship IDs per user
    const relationships = await RelationshipModel.find(
      { userId: { $in: userIds } },
      { _id: 1, userId: 1 }
    ).lean();

    const matchCountMap = new Map();
    const userRelIdsMap = new Map();
    relationships.forEach((rel) => {
      matchCountMap.set(rel.userId, (matchCountMap.get(rel.userId) || 0) + 1);
      if (!userRelIdsMap.has(rel.userId)) {
        userRelIdsMap.set(rel.userId, []);
      }
      userRelIdsMap.get(rel.userId).push(rel._id);
    });

    // Aggregate message counts per user
    const allRelIds = relationships.map((r) => r._id);
    const messageCounts = await MessageModel.aggregate([
      { $match: { relationshipId: { $in: allRelIds }, role: "user" } },
      {
        $group: {
          _id: "$relationshipId",
          count: { $sum: 1 },
        },
      },
    ]);
    const relMsgMap = new Map(messageCounts.map((m) => [m._id.toString(), m.count]));

    const usersWithStats = users.map((u) => {
      const sw = swipeMap.get(u.userId) || { totalSwipes: 0, likes: 0, passes: 0 };
      const relIds = userRelIdsMap.get(u.userId) || [];
      let totalUserMessages = 0;
      relIds.forEach((rid) => {
        totalUserMessages += relMsgMap.get(rid.toString()) || 0;
      });

      return {
        _id: u._id,
        userId: u.userId,
        name: u.name || "Anonymous",
        email: u.email || "",
        avatarUrl: u.avatarUrl || "",
        platform: u.platform || "unknown",
        isPremium: Boolean(u.isPremium),
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        swipesCount: sw.totalSwipes,
        likesCount: sw.likes,
        passesCount: sw.passes,
        matchesCount: matchCountMap.get(u.userId) || 0,
        messagesCount: totalUserMessages,
      };
    });

    const result = {
      users: usersWithStats,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };

    setServerCached(cacheKey, result);
    setResponseCacheHeader(res, "MISS");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 3. User Details Drilldown
analyticsRouter.get("/users/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    const forceFresh = req.query.fresh === "true" || req.headers["cache-control"] === "no-cache";
    const cacheKey = `user:${userId}`;

    const cached = getServerCached(cacheKey, forceFresh);
    if (cached) {
      setResponseCacheHeader(res, "HIT");
      return res.json(cached);
    }

    const user = await UserModel.findOne({ userId }).lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Swipes statistics
    const [swipesTotal, likesCount, passesCount] = await Promise.all([
      SwipeModel.countDocuments({ userId }),
      SwipeModel.countDocuments({ userId, direction: "like" }),
      SwipeModel.countDocuments({ userId, direction: "pass" }),
    ]);

    // Relationships (Matches)
    const relationships = await RelationshipModel.find({ userId })
      .populate("characterId", "name avatarUrl slug gender")
      .sort({ updatedAt: -1 })
      .lean();

    const relIds = relationships.map((r) => r._id);

    // Messages breakdown for this user's relationships
    const messagesStats = await MessageModel.aggregate([
      { $match: { relationshipId: { $in: relIds } } },
      {
        $group: {
          _id: "$relationshipId",
          totalMessages: { $sum: 1 },
          userMessages: { $sum: { $cond: [{ $eq: ["$role", "user"] }, 1, 0] } },
          assistantMessages: { $sum: { $cond: [{ $eq: ["$role", "assistant"] }, 1, 0] } },
          lastMessageAt: { $max: "$createdAt" },
        },
      },
    ]);
    const msgStatsMap = new Map(messagesStats.map((m) => [m._id.toString(), m]));

    const enrichedRelationships = relationships.map((r) => {
      const stats = msgStatsMap.get(r._id.toString()) || {
        totalMessages: 0,
        userMessages: 0,
        assistantMessages: 0,
        lastMessageAt: r.createdAt,
      };
      return {
        _id: r._id,
        character: r.characterId,
        stage: r.stage || "new",
        mood: r.mood || "neutral",
        totalMessages: stats.totalMessages,
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        lastMessageAt: stats.lastMessageAt,
        createdAt: r.createdAt,
      };
    });

    const totalUserMessages = enrichedRelationships.reduce((sum, r) => sum + r.userMessages, 0);
    const totalAssistantMessages = enrichedRelationships.reduce((sum, r) => sum + r.assistantMessages, 0);

    // Last 15 recent swipes
    const recentSwipes = await SwipeModel.find({ userId })
      .populate("characterId", "name avatarUrl")
      .sort({ createdAt: -1 })
      .limit(15)
      .lean();

    const result = {
      user: {
        _id: user._id,
        userId: user.userId,
        name: user.name || "Anonymous",
        email: user.email || "",
        avatarUrl: user.avatarUrl || "",
        platform: user.platform || "unknown",
        isPremium: Boolean(user.isPremium),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      stats: {
        swipesTotal,
        likesCount,
        passesCount,
        matchesCount: relationships.length,
        userMessages: totalUserMessages,
        assistantMessages: totalAssistantMessages,
        totalMessages: totalUserMessages + totalAssistantMessages,
      },
      relationships: enrichedRelationships,
      recentSwipes: recentSwipes.map((s) => ({
        _id: s._id,
        characterName: s.characterId?.name || "Unknown",
        characterAvatar: s.characterId?.avatarUrl || "",
        direction: s.direction,
        outcome: s.outcome,
        createdAt: s.createdAt,
      })),
    };

    setServerCached(cacheKey, result);
    setResponseCacheHeader(res, "MISS");
    res.json(result);
  } catch (err) {
    next(err);
  }
});
