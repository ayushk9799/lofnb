import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceDir = path.resolve(__dirname, "../../lofn-web/dist");
const targetDir = path.resolve(__dirname, "../public");

if (!fs.existsSync(sourceDir)) {
  console.error(
    `Error: Source directory "${sourceDir}" does not exist. Run "npm run build:web" first.`,
  );
  process.exit(1);
}

if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}

fs.cpSync(sourceDir, targetDir, { recursive: true });
