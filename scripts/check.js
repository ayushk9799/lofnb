import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function check(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await check(path);
        else if (path.endsWith(".js")) {
            const result = spawnSync(process.execPath, ["--check", path], {stdio: "inherit"});
            if (result.status) process.exit(result.status);
        }
    }
}
await check("src");
await check("scripts");
console.log("Backend syntax checks passed");
