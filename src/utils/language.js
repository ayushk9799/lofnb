// Languages the mobile app ships. Keep in sync with lofnf/src/i18n/index.js.
export const SUPPORTED_LANGUAGES = ["en", "ja", "ko", "de", "fr", "it", "es"];
export const TRANSLATION_LANGUAGES = SUPPORTED_LANGUAGES.filter(code => code !== "en");
export const LANGUAGE_NAMES = {
    en: "English",
    ja: "Japanese",
    ko: "Korean",
    de: "German",
    fr: "French",
    it: "Italian",
    es: "Spanish",
};

/**
 * Resolve an Accept-Language header or stored code to a supported language.
 * Only the first (preferred) tag counts; regional variants use the base language.
 */
export function resolveLanguage(value) {
    const first = typeof value === "string" ? value.split(",")[0] : "";
    const base = first.split(";")[0].trim().toLowerCase().split(/[-_]/)[0];
    return SUPPORTED_LANGUAGES.includes(base) ? base : "en";
}
