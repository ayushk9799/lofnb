import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOWNLOADS_DIR = path.resolve(process.env.HOME || "/Users/ayushkumar", "Downloads");
const IMAGE_1_PATH = path.join(DOWNLOADS_DIR, "1_Maya.png");
const IMAGE_2_PATH = path.join(DOWNLOADS_DIR, "2_Maya.png");
const IMAGE_3_PATH = path.join(DOWNLOADS_DIR, "3_Maya.png");

async function main() {
  console.log("=== Uploading Maya Images to Cloudflare R2 ===");

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

  console.log("Reading images from Downloads...");
  const buf1 = await readFile(IMAGE_1_PATH);
  const buf2 = await readFile(IMAGE_2_PATH);
  const buf3 = await readFile(IMAGE_3_PATH);
  console.log(`- 1_Maya.png: ${buf1.length} bytes`);
  console.log(`- 2_Maya.png: ${buf2.length} bytes`);
  console.log(`- 3_Maya.png: ${buf3.length} bytes`);

  async function upload(key, buffer, contentType = "image/png") {
    console.log(` Uploading ${key} (${buffer.length} bytes)...`);
    await s3.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    const publicUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
    console.log(` -> Done: ${publicUrl}`);
    return publicUrl;
  }

  // 1. Upload to clean slug path characters/maya/
  const avatarUrl = await upload("characters/maya/avatar.png", buf1);
  const photo1Url = await upload("characters/maya/photos/0_dinner.png", buf1);
  const photo2Url = await upload("characters/maya/photos/1_market.png", buf2);
  const photo3Url = await upload("characters/maya/photos/2_dumbo.png", buf3);

  // 2. Overwrite legacy keys for backward-compatibility with cached/old clients
  console.log("\nUpdating legacy R2 keys for cache consistency...");
  await upload("characters/6a9b74b263974ba7dac3a6b6/avatar.jpg", buf1);
  await upload("characters/6a9b74b263974ba7dac3a6b6/photos/0_945dac1d.jpg", buf1);
  await upload("characters/6a9b74b263974ba7dac3a6b6/photos/1_46377172.jpg", buf2);
  await upload("characters/6a9b74b263974ba7dac3a6b6/photos/2_dd0aedf6.jpg", buf3);
  await upload("characters/6a9b74b263974ba7dac3a6b6/photos/3_9f20e0d8.jpg", buf1);

  const photos = [photo1Url, photo2Url, photo3Url];
  const gallery = [
    {
      url: photo1Url,
      caption: "Late dinner and good conversations",
    },
    {
      url: photo2Url,
      caption: "Golden hour strolling through Brooklyn market",
    },
    {
      url: photo3Url,
      caption: "Out testing my vintage 35mm lens in DUMBO",
    },
  ];

  // 3. Update MongoDB
  console.log("\nConnecting to MongoDB to update Maya record...");
  await connectDatabase(env.MONGODB_URI);
  try {
    const updateResult = await CharacterModel.updateOne(
      { slug: "maya" },
      {
        $set: {
          avatarUrl,
          photos,
          gallery,
        },
      }
    );
    console.log("MongoDB update result:", updateResult);
  } finally {
    await disconnectDatabase();
  }

  // 4. Update data/characters.example.json
  console.log("\nUpdating data/characters.example.json...");
  const catalogPath = path.resolve(__dirname, "../data/characters.example.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const mayaIndex = catalog.findIndex((c) => c.slug === "maya");
  if (mayaIndex !== -1) {
    catalog[mayaIndex].avatarUrl = avatarUrl;
    catalog[mayaIndex].photos = photos;
    catalog[mayaIndex].gallery = gallery;
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
    console.log("data/characters.example.json updated successfully.");
  } else {
    console.warn("Could not find slug 'maya' in characters.example.json");
  }

  console.log("\n=== Upload and database update complete! ===");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
