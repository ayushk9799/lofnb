import { MemoryModel } from "../models/memory.model.js";

export const DOSSIER_CATEGORIES = ["fact", "preference", "habit", "inside_joke", "current_life"];
const quotas = { fact: 6, preference: 4, habit: 4, inside_joke: 3, current_life: 5 };
const DAY = 86_400_000;

// The dossier is a bounded projection of canonical memories, never a second
// independently generated biography. Rebuilding it also removes superseded facts.
export function buildDossier(memories, now = new Date()) {
  const counts = {};
  let remaining = 4200;
  const entries = [];
  for (const memory of [...memories].sort((a, b) =>
    Number(b.importance || 0) - Number(a.importance || 0) ||
    new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))) {
    const category = memory.dossierCategory;
    if (!DOSSIER_CATEGORIES.includes(category) || memory.status !== "active" ||
        Number(memory.confidence) < 0.75 ||
        (memory.expiresAt && new Date(memory.expiresAt) <= now) ||
        String(memory.normalizedKey).startsWith("user_boundary_") ||
        (counts[category] || 0) >= quotas[category]) continue;
    // Never truncate a fact mid-sentence: extraction supplies short facts.
    if (memory.text.length > 500 || memory.text.length > remaining) continue;
    remaining -= memory.text.length;
    counts[category] = (counts[category] || 0) + 1;
    entries.push({
      memoryId: memory._id, key: memory.normalizedKey, category,
      text: memory.text, updatedAt: memory.updatedAt, expiresAt: memory.expiresAt,
      lastMentionedAt: memory.lastMentionedAt,
    });
  }
  return { version: 1, updatedAt: now, entries };
}

export async function refreshDossier(relationship, session) {
  const memories = await MemoryModel.find({
    relationshipId: relationship._id, userId: relationship.userId,
    status: "active", dossierCategory: { $in: DOSSIER_CATEGORIES },
  }).select("normalizedKey text dossierCategory confidence importance status updatedAt expiresAt lastMentionedAt")
    .session(session).lean();
  relationship.userDossier = buildDossier(memories);
}

export function dossierContext(dossier, now = new Date()) {
  return (dossier?.entries || [])
    .filter(entry => !entry.expiresAt || new Date(entry.expiresAt) > now)
    .map(entry => ({
      category: entry.category, text: entry.text,
      ...(entry.category === "current_life" ? { recordedAt: entry.updatedAt, expiresAt: entry.expiresAt } : {}),
      ...(entry.lastMentionedAt && now - new Date(entry.lastMentionedAt) < 3 * DAY
        ? { recentlyMentioned: true } : {}),
    }));
}

// User facts are promoted only with direct evidence. A joke additionally needs
// the user's participation; an assistant inventing a joke is not shared history.
export function groundedDossierMetadata(value, user, occurredAt) {
  const supported = Boolean(value.evidence?.trim() && user?.content.includes(value.evidence));
  const category = supported && DOSSIER_CATEGORIES.includes(value.dossierCategory)
    && ["user_fact", "preference", "shared_event"].includes(value.type)
    ? value.dossierCategory : undefined;
  let expiresAt;
  if (category === "current_life") {
    const proposed = value.expiresAt ? new Date(value.expiresAt) : null;
    const cap = new Date(new Date(occurredAt).getTime() + 90 * DAY);
    expiresAt = proposed && Number.isFinite(proposed.getTime())
      ? new Date(Math.min(proposed.getTime(), cap.getTime()))
      : new Date(new Date(occurredAt).getTime() + 7 * DAY);
  }
  return { dossierCategory: category, evidence: supported ? value.evidence : undefined, expiresAt };
}

export const DOSSIER_EXTRACTION_INSTRUCTIONS = [
  "Each memory may include dossierCategory: fact|preference|habit|inside_joke|current_life, evidence, expiresAt (ISO date or null).",
  "Evidence must be an exact quote from the CURRENT USER message supporting the fact. Without evidence omit dossierCategory. Never promote assistant claims about the user.",
  "Use fact for stable identity, preference for likes/dislikes, habit for recurring behavior explicitly stated by the user. Keep each dossier fact under 500 characters. Store current truth, not guesses or instructions.",
  "Use inside_joke only for an established shared reference the user participates in or acknowledges; include its origin and meaning. Never turn your own new joke into shared history.",
  "Use current_life for temporary situations, plans and upcoming events. Include explicit calendar dates in text, using occurredAt to resolve today/tomorrow, and expiresAt when the situation stops being current. Default expiry is 7 days; maximum 90 days. Never invent an outcome.",
  "Reuse an existing memory key for corrections (e.g. quitting a game replaces the gaming habit with the current fact). Use existingMemories and previousDossier to avoid contradictory duplicates. Do not preserve corrected facts in relationshipSummary.",
  "relationshipSummary is a compact account of older conversation threads and shared events, not a duplicate user profile. Preserve important unresolved context; latest user corrections win.",
  "Optionally return callbacks:[{key,evidence}] for existing memories actually mentioned in the CURRENT ASSISTANT response. Evidence must be an exact assistant quote; do not record retrieval as a mention.",
].join("\n");
