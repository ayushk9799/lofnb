# Character dialogue examples

Author 8–12 examples per character in the catalog's `dialogueExamples` array. Each entry has `situation`, `user`, `assistant`, optional `keywords`, and optional `stages` (new, friends, close, romantic). Supported situations: greeting, disagreement, misunderstanding, excitement, vulnerability, boundaries, ordinary. Include everyday exchanges as well as emotional moments. Examples should demonstrate voice rather than repeat biographical facts or a single catchphrase.

The local selector ranks current-message cues and word matches, with recent history as a weaker signal. It inserts at most three relevant demonstrations within an estimated 650-token budget, excluding examples restricted to other relationship stages. Unrelated queries may select none. Initiated messages do not select user-response examples. This is a heuristic, not a semantic intent classifier; add evaluation cases when tuning it.

Examples appear in a labeled fictional section of the prompt, not as real historical messages. Optional examples are removed if needed to preserve space for recent history. Keep `promptTemplate` focused on voice; avoid embedding another always-present example bank there.

Validate a catalog with `npm --prefix backend run seed -- --check path/to/catalog.json`. Import it with `npm --prefix backend run seed -- path/to/catalog.json`; add `--update` to intentionally replace matching character definitions. The default seed backfills missing examples and voice prompts without replacing authored fields. Existing characters without examples still work.

Maya's bundled catalog includes 12 examples. Her distress example uses “should i distract you?” because she is describing her own action.

## Tone feedback and extra messages

Feedback about the character's delivery (for example, “you sound like a chatbot”) gets a brief, turn-specific repair instruction after recent history. Ordinary dialogue examples are omitted for that turn so they do not distract from the feedback. The repair should acknowledge the awkward wording without a biography, customer-service apology, promise, or unrelated question. Recognition is heuristic; regression tests include normal discussions of LinkedIn and photography to reduce false positives.

The frontend no longer schedules random 16-second double texts or 90-second idle nudges. Explicit “text first” and the existing longer-term check-in worker remain available. The backend also skips legacy timed follow-up/nudge requests after tone feedback and returns `{data: null, skipped: true}` without generating or saving another message.
