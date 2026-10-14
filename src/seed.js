import { readFile } from "node:fs/promises";
import path from "node:path";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { importCharacterCatalog, validateCharacterCatalog } from "./services/character-catalog.service.js";

const args = process.argv.slice(2);
const flags = new Set(["--update", "--check"]);
if (args.some(arg => arg.startsWith("--") && !flags.has(arg))) throw new Error("Supported flags: --check, --update");
const files = args.filter(arg => !arg.startsWith("--"));
if (files.length > 1) throw new Error("Provide one JSON catalog file");
const file = files[0] ? path.resolve(files[0]) : new URL("../data/characters.example.json", import.meta.url);
const records = JSON.parse(await readFile(file, "utf8"));
await validateCharacterCatalog(records);
if (args.includes("--check")) {
    console.log(`Validated ${records.length} character records`);
} else {
    const {env} = await import("./config/env.js");
    await connectDatabase(env.MONGODB_URI);
    try {
        const result = await importCharacterCatalog(records, {update: args.includes("--update")});
        console.log(`Imported ${result.total} characters (${result.inserted} new, ${result.updated} updated)`);
    } finally { await disconnectDatabase(); }
}
