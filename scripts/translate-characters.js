import { format as formatCliOutput } from 'node:util';
// Translate every character's public profile into the app's languages and save
// it on the character in MongoDB (translations.<lang>). Safe to re-run: it only
// translates languages that are missing or were made from older English text.
//
//   npm run characters:translate -- --dry-run          print, don't save
//   npm run characters:translate -- --lang ja,ko       only these languages
//   npm run characters:translate -- --slug maya        only these characters
//   npm run characters:translate -- --force            redo even if up to date
//   npm run characters:translate -- --status           show what is saved, change nothing
//
// Uses LLM_MODEL, or TRANSLATION_MODEL if set.
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible.provider.js";
import { PUBLIC_CHARACTER_FIELDS } from "../src/services/character-locale.js";
import { staleLanguages, translateCharacterProfile } from "../src/services/character-translation.service.js";
import { TRANSLATION_LANGUAGES } from "../src/utils/language.js";

const args = process.argv.slice(2);
const option = name => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const statusOnly = args.includes("--status");
const languages = option("lang") ? option("lang").split(",").map(code => code.trim()) : TRANSLATION_LANGUAGES;
const slugs = option("slug") ? option("slug").split(",").map(slug => slug.trim().toLowerCase()) : null;

const unknown = languages.filter(code => !TRANSLATION_LANGUAGES.includes(code));
if (unknown.length) {
    console.error(`Unknown language(s): ${unknown.join(", ")}. Use: ${TRANSLATION_LANGUAGES.join(", ")}`);
    process.exit(1);
}
if (statusOnly) {
    await connectDatabase(env.MONGODB_URI);
    try {
        const characters = await CharacterModel.find(slugs ? { slug: { $in: slugs } } : {})
            .select([...PUBLIC_CHARACTER_FIELDS, "translations"].join(" "))
            .sort({ slug: 1 })
            .lean();
        void process.stdout.write(formatCliOutput(`Database: ${env.MONGODB_URI.replace(/\/\/[^@]*@/, "//***@")}`) + '\n');
        void process.stdout.write(formatCliOutput(`${characters.length} character(s). Per language: saved and up to date / saved but English changed since / missing`) + '\n');
        for (const code of languages) {
            const stale = characters.filter(c => staleLanguages(c, [code]).length);
            const saved = characters.filter(c => c.translations?.[code]);
            void process.stdout.write(formatCliOutput(`  ${code}: ${characters.length - stale.length} / ${saved.length - (characters.length - stale.length)} / ${characters.length - saved.length}`) + '\n');
        }
        const sample = characters.find(c => c.translations?.[languages[0]]);
        if (sample) void process.stdout.write(formatCliOutput(`\nExample (${sample.slug}, ${languages[0]}): ${sample.translations[languages[0]].summary?.slice(0, 160)}`) + '\n');
    } finally {
        await disconnectDatabase();
    }
    process.exit(0);
}
const model = process.env.TRANSLATION_MODEL || env.LLM_MODEL;
if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !model) {
    console.error("Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (or TRANSLATION_MODEL).");
    process.exit(1);
}
const llm = new OpenAiCompatibleProvider({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model });

await connectDatabase(env.MONGODB_URI);
let done = 0;
let skipped = 0;
const failures = [];
try {
    const characters = await CharacterModel.find(slugs ? { slug: { $in: slugs } } : {})
        .select([...PUBLIC_CHARACTER_FIELDS, "translations"].join(" "))
        .sort({ slug: 1 })
        .lean();
    void process.stdout.write(formatCliOutput(`${characters.length} character(s), languages: ${languages.join(", ")}, model: ${model}${dryRun ? " (dry run)" : ""}`) + '\n');
    for (const character of characters) {
        const todo = staleLanguages(character, languages, { force });
        skipped += languages.length - todo.length;
        if (!todo.length) continue;
        // One character at a time, its languages in parallel.
        const results = await Promise.allSettled(todo.map(async language => {
            const translation = await translateCharacterProfile({ character, language, llm });
            if (dryRun) {
                void process.stdout.write(formatCliOutput(`\n=== ${character.slug} [${language}]\n${JSON.stringify(translation, null, 2)}`) + '\n');
            } else {
                await CharacterModel.updateOne(
                    { _id: character._id },
                    { $set: { [`translations.${language}`]: translation } },
                    { runValidators: true },
                );
            }
            return language;
        }));
        results.forEach((result, index) => {
            if (result.status === "fulfilled") done++;
            else failures.push(`${character.slug} [${todo[index]}]: ${result.reason?.message || result.reason}`);
        });
        void process.stdout.write(formatCliOutput(`${character.slug}: ${results.filter(r => r.status === "fulfilled").map(r => r.value).join(", ") || "-"}`
            + `${results.some(r => r.status === "rejected") ? " (some failed)" : ""}`) + '\n');
    }
} finally {
    await disconnectDatabase();
}
void process.stdout.write(formatCliOutput(`\n${dryRun ? "Translated (not saved)" : "Saved"}: ${done}. Already up to date: ${skipped}. Failed: ${failures.length}.`) + '\n');
if (failures.length) {
    failures.forEach(line => void process.stdout.write(formatCliOutput(`  ${line}`) + '\n'));
    void process.stdout.write(formatCliOutput("Re-run the same command to retry only what failed.") + '\n');
    process.exitCode = 1;
}
