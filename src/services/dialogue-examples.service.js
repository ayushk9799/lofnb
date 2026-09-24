import { estimateTokens } from "../utils/tokens.js";

const cues = {
  greeting: /\b(hey|hello|hi|what's up|yo)\b/i,
  disagreement: /\b(disagree|overrated|wrong|don't agree|do not agree)\b/i,
  misunderstanding:
    /\b(meant|misunderstood|misread|actually|correction|not what i|what do you mean|what did you mean|what does that mean|wdym)\b/i,
  excitement: /!!|\b(excited|got the job|passed|finally|can't wait)\b/i,
  vulnerability:
    /\b(awful|rough|sad|lonely|scared|hurt|serious|listen|bad day)\b/i,
  boundaries:
    /\b(stop|don't call|do not call|uncomfortable|friendly|friendship|no flirting|leave me alone|sex|sleep with)\b/i,
  ordinary:
    /\b(nothing|much|laundry|dinner|pasta|cooking|boring|okay|ok|yeah|great|good|fine|cool|linkedin|corporate)\b/i,
};
const words = (text) =>
  new Set(
    String(text || "")
      .toLowerCase()
      .match(/[\p{L}\p{N}']+/gu) || [],
  );

// Local selection adds no model round trip. Examples are demonstrations, never history.
export function selectDialogueExamples(
  character,
  {
    currentMessage = "",
    history = [],
    stage = "new",
    limit = 1,
    tokenBudget = 220,
  } = {},
) {
  const currentWords = words(currentMessage);
  const previousWords = words(
    history
      .slice(-4)
      .map((message) => message.content)
      .join(" "),
  );
  const ranked = (character.dialogueExamples || [])
    .filter(
      (example) => !example.stages?.length || example.stages.includes(stage),
    )
    .map((example, index) => {
      const relevantWords = new Set([
        ...words(example.user),
        ...(example.keywords || []).flatMap((keyword) => [...words(keyword)]),
      ]);
const flirtyTerms = /\b(darling|babe|baby|sexy|cutie|sweetheart|honey|gorgeous|handsome|beautiful|hot|hottie)\b/i;

      // Broad "ordinary" cues used to inject an arbitrary lifestyle example
      // for replies such as "ok" or "great". Ordinary examples now require
      // an actual word/topic match; emotional/safety situations may use cues.
      // Flirty messages and pet names should not be anchored by a vanilla greeting example.
      const isFlirtyGreeting =
        example.situation === "greeting" && flirtyTerms.test(currentMessage);
      let score =
        example.situation !== "ordinary" &&
        !isFlirtyGreeting &&
        cues[example.situation]?.test(currentMessage)
          ? 4
          : 0;
      for (const word of relevantWords) {
        if (
          word.length < 3 ||
          [
            "the",
            "and",
            "you",
            "your",
            "that",
            "this",
            "was",
            "with",
            "just",
          ].includes(word)
        )
          continue;
        if (currentWords.has(word)) score += 2;
        if (previousWords.has(word)) score += 0.25;
      }
      const normalizedMessage = String(currentMessage || "").toLowerCase();
      if (
        (example.keywords || []).some((keyword) => {
          const normalizedKeyword = String(keyword).toLowerCase();
          return (
            normalizedMessage === normalizedKeyword ||
            (normalizedKeyword.length >= 4 &&
              normalizedMessage.includes(normalizedKeyword))
          );
        })
      )
        score += 4;
      return { example, index, score };
    })
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let used = 0;
  for (const { example } of ranked) {
    const cost =
      estimateTokens(
        JSON.stringify({
          situation: example.situation,
          user: example.user,
          assistant: example.assistant,
        }),
      ) + 8;
    if (used + cost > tokenBudget) continue;
    selected.push(example);
    used += cost;
    if (selected.length >= Math.max(0, limit)) break;
  }
  return limit > 0 ? selected : [];
}
