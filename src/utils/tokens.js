export function estimateTokens(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / 4);
}
export function takeNewestWithinTokenBudget(newestFirst, tokenBudget) {
    if (tokenBudget <= 4) return [];
    const selected = [];
    let used = 0;
    for (const message of newestFirst) {
        const cost = estimateTokens(message.content) + 4;
        if (selected.length > 0 && used + cost > tokenBudget)
            break;
        if (cost > tokenBudget && selected.length === 0) {
            selected.push({
                ...message,
                content: message.content.slice(-Math.max(0, (tokenBudget - 4) * 4)),
            });
            break;
        }
        selected.push(message);
        used += cost;
    }
    return selected.reverse();
}
export function normalizeMemoryKey(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 240);
}
