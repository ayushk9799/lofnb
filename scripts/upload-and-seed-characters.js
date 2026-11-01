import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { importCharacterCatalog, validateCharacterCatalog } from "../src/services/character-catalog.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTERS_SRC_DIR = path.resolve(__dirname, "../../lofncharacters/characters");
const IMAGES_SRC_DIR = path.resolve(__dirname, "../../lofncharacters/images");
const BACKEND_CATALOG_PATH = path.resolve(__dirname, "../data/characters.example.json");

const TARGET_SLUGS = [
  "sienna",
  "kaito",
  "noa",
  "dante",
  "lyra",
  "freja",
  "samira",
  "julian"
];

async function main() {

  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new Error("Missing Cloudflare R2 configuration in environment variables");
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  const publicBaseUrl = (env.R2_PUBLIC_URL || "https://r2.lofnchat.com").replace(/\/$/, "");

  async function uploadToR2(key, filePath) {
    const buffer = await readFile(filePath);
    await s3.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
    }));
    const publicUrl = `${publicBaseUrl}/${key}`;
    return { publicUrl, sizeKb: (buffer.length / 1024).toFixed(0) };
  }

  // 1. Upload Images to Cloudflare R2

  for (const slug of TARGET_SLUGS) {
    const charImgDir = path.join(IMAGES_SRC_DIR, slug);
    if (!fs.existsSync(charImgDir)) {
      console.warn(`⚠️ Warning: Image directory for ${slug} not found at ${charImgDir}`);
      continue;
    }

    const files = fs.readdirSync(charImgDir).filter(f => f.endsWith(".png"));

    for (const filename of files) {
      const filePath = path.join(charImgDir, filename);
      let r2Key;
      if (filename === "avatar.png") {
        r2Key = `characters/${slug}/avatar.png`;
      } else {
        r2Key = `characters/${slug}/photos/${filename}`;
      }

      process.stdout.write(`     Uploading ${filename} -> ${r2Key}... `);
      try {
        await uploadToR2(r2Key, filePath);

      } catch (err) {
        console.error(`❌ FAILED: ${err.message}`);
        throw err;
      }
    }
  }

  // 2. Load and validate character JSONs

  const newCharacters = [];
  for (const slug of TARGET_SLUGS) {
    const jsonPath = path.join(CHARACTERS_SRC_DIR, `${slug}.json`);
    const raw = await readFile(jsonPath, "utf8");
    const charData = JSON.parse(raw);
    newCharacters.push(charData);

  }

  // 3. Merge with existing backend catalog (which contains Maya)

  let existingCatalog;
  try {
    existingCatalog = JSON.parse(await readFile(BACKEND_CATALOG_PATH, "utf8"));
  } catch {
    existingCatalog = [];
  }

  const catalogMap = new Map();
  // Keep Maya or any existing verified characters
  for (const char of existingCatalog) {
    catalogMap.set(char.slug, char);
  }
  // Add/update new characters
  for (const char of newCharacters) {
    catalogMap.set(char.slug, char);
  }

  const mergedCatalog = Array.from(catalogMap.values());

  // Validate entire catalog with Lofnb's Mongoose validator
  await validateCharacterCatalog(mergedCatalog);

  await writeFile(BACKEND_CATALOG_PATH, JSON.stringify(mergedCatalog, null, 2) + "\n", "utf8");

  // 4. Seed into MongoDB

  await connectDatabase(env.MONGODB_URI);

  try {
    await importCharacterCatalog(mergedCatalog, { update: true, fillMissingPrompts: true });

    // Verify in database
    await CharacterModel.find({}, "slug name gender occupation location avatarUrl gallery").lean();
  } finally {
    await disconnectDatabase();
  }

}

main().catch(err => {
  console.error("\n❌ Execution failed:", err);
  process.exit(1);
});
