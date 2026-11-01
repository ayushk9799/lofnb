import { UserModel } from "../models/user.model.js";
import { resolveLanguage } from "../utils/language.js";

const REMEMBER_MS = 5 * 60_000;
const MAX_REMEMBERED = 10_000;
const remembered = new Map();

/**
 * Sets request.language from the mobile app's headers and saves it on the user,
 * so background jobs (openers, check-ins, push) use the same language.
 *
 * Only the mobile app picks a language and it always sends X-Device-Language
 * with it. The website's Accept-Language is just the browser default while its
 * UI is English, so it neither sets nor overwrites the saved choice.
 */
export function createLanguageMiddleware() {
    return async (request, _response, next) => {
        if (!request.header("x-device-language")) return next();
        const language = resolveLanguage(request.header("accept-language"));
        request.language = language;
        const userId = request.auth?.userId;
        const seen = userId ? remembered.get(userId) : undefined;
        if (!userId || (seen?.language === language && Date.now() - seen.at < REMEMBER_MS)) return next();
        try {
            // Await the write so a chat request right after a switch already uses it.
            await UserModel.updateOne({ userId, language: { $ne: language } }, { $set: { language } });
            if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
            remembered.delete(userId);
            remembered.set(userId, { language, at: Date.now() });
        } catch {
            // Saving the preference must never block the request.
        }
        next();
    };
}

/** Test hook. */
export function forgetRememberedLanguages() {
    remembered.clear();
}
