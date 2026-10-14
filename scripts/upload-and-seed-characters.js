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
  console.log("🚀 Starting character upload and seed process...");

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
  console.log("\n📤 1. Uploading character images to Cloudflare R2...");
  let totalUploaded = 0;

  for (const slug of TARGET_SLUGS) {
    const charImgDir = path.join(IMAGES_SRC_DIR, slug);
    if (!fs.existsSync(charImgDir)) {
      console.warn(`⚠️ Warning: Image directory for ${slug} not found at ${charImgDir}`);
      continue;
    }

    console.log(`\n  📸 Processing images for [${slug}]...`);
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
        const { publicUrl, sizeKb } = await uploadToR2(r2Key, filePath);
        console.log(`✅ OK (${sizeKb} KB)`);
        totalUploaded++;
      } catch (err) {
        console.error(`❌ FAILED: ${err.message}`);
        throw err;
      }
    }
  }

  console.log(`\n🎉 Uploaded ${totalUploaded} images to Cloudflare R2 successfully!`);

  // 2. Load and validate character JSONs
  console.log("\n📦 2. Loading character profiles...");
  const newCharacters = [];
  for (const slug of TARGET_SLUGS) {
    const jsonPath = path.join(CHARACTERS_SRC_DIR, `${slug}.json`);
    const raw = await readFile(jsonPath, "utf8");
    const charData = JSON.parse(raw);
    newCharacters.push(charData);
    console.log(`  Loaded profile: ${charData.name} (${charData.slug})`);
  }

  // 3. Merge with existing backend catalog (which contains Maya)
  console.log("\n📋 3. Updating backend catalog (data/characters.example.json)...");
  let existingCatalog = [];
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
  console.log(`  ✅ All ${mergedCatalog.length} characters passed Lofnb schema validation!`);

  await writeFile(BACKEND_CATALOG_PATH, JSON.stringify(mergedCatalog, null, 2) + "\n", "utf8");
  console.log(`  💾 Saved updated catalog to ${BACKEND_CATALOG_PATH}`);

  // 4. Seed into MongoDB
  console.log("\n🌱 4. Seeding characters into MongoDB...");
  await connectDatabase(env.MONGODB_URI);

  try {
    const result = await importCharacterCatalog(mergedCatalog, { update: true, fillMissingPrompts: true });
    console.log(`  ✅ Import completed: ${result.total} total characters (${result.inserted} inserted, ${result.updated} updated)`);

    // Verify in database
    const dbCharacters = await CharacterModel.find({}, "slug name gender occupation location avatarUrl gallery").lean();
    console.log(`\n🔍 5. Verification - Active characters in MongoDB (${dbCharacters.length} total):`);
    for (const [idx, c] of dbCharacters.entries()) {
      console.log(`  [${idx + 1}/${dbCharacters.length}] ${c.name} (${c.slug}) | ${c.gender} | ${c.occupation} | ${c.location} | Gallery: ${c.gallery?.length || 0} photos`);
      console.log(`      Avatar:  ${c.avatarUrl}`);
      if (c.gallery?.length) {
        console.log(`      Gallery: ${c.gallery[0].url}`);
      }
    }
  } finally {
    await disconnectDatabase();
  }

  console.log("\n✨ All profiles successfully uploaded to Cloudflare R2 and seeded into Lofn!");
}

main().catch(err => {
  console.error("\n❌ Execution failed:", err);
  process.exit(1);
});
