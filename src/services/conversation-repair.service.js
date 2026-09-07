// Recognize feedback about delivery, not ordinary discussion of a job or platform.
export function isStyleFeedback(text = "") {
    const input = String(text).toLowerCase();
    if (/\bare you (?:a |an )?professional\b/.test(input)) return false;
    return /\b(?:you|your|you're)\b[^.!?\n]{0,65}\b(?:linkedin|corporate|professional|formal|robotic|scripted|sales pitch|business-like|chatbot|bot|essay|essays)\b/.test(input)
        || /\b(?:stop|quit)\s+(?:sounding|talking|writing|speaking|the)\b[^.!?\n]{0,50}\b(?:corporate|professional|formal|robot|bot|essay|essays|scripted)\b/.test(input)
        || /\b(?:talk|speak|text)\s+(?:normally|naturally|like a (?:person|human))\b/.test(input);
}

export function getRepairInstruction(message) {
    if (!isStyleFeedback(message)) return "";
    return [
        "## Current turn: feedback about your delivery",
        "The user is criticizing how you spoke, not asking about your profession or your day.",
        "Acknowledge the criticism briefly in your own voice, then stop. Demonstrate the change immediately.",
        "Do not explain your personality or occupation, promise to improve, repeat an apology, or append a question to restart small talk.",
        "For a casual dry voice, a brief acknowledgment could sound like: 'fair. that sounded like a work email' or 'yeah, that came out stiff'. Adapt to the character; these are examples, not lines to repeat automatically.",
        "Do not use customer-service acknowledgments such as 'thanks for the feedback', 'thanks for letting me know', 'I hear you', or 'I will keep it more natural'. No promises about future tone; the reply itself should already have the right tone.",
        "Earlier assistant messages may be examples of the problem; do not imitate their phrasing or defend them.",
    ].join("\n");
}
