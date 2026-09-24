import { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { CharacterModel } from "../src/models/character.model.js";
import { UserModel } from "../src/models/user.model.js";
import { StorageService } from "../src/services/storage.service.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  const env = process.env;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new Error("Missing Cloudflare R2 configuration in environment variables");
  }

  const storage = new StorageService(env);
  if (!storage.isR2Configured()) {
    throw new Error("StorageService could not initialize S3Client for R2");
  }

  await connectDatabase(env.MONGODB_URI);

  // 1. Migrate Characters
  const characters = await CharacterModel.find({});

  for (const char of characters) {
    const charId = String(char._id);

    // 1a. Upload Avatar
    let avatarUrl = char.avatarUrl;
    if (avatarUrl && !avatarUrl.includes(".r2.cloudflarestorage.com") && !avatarUrl.includes("r2.dev") && !avatarUrl.includes("r2.lofnchat.com")) {
      try {
        const buf = await fetchBuffer(avatarUrl);
        const result = await storage.upload({
          buffer: buf,
          folder: `characters/${charId}`,
          filename: `avatar.jpg`,
        });
        char.avatarUrl = result.url;
      } catch (err) {
        console.error(` Failed to upload character avatar:`, err.message);
      }
    }

    // 1b. Upload Gallery & Photos (Index-wise)
    const galleryItems = Array.isArray(char.gallery) ? [...char.gallery] : [];
    const newPhotos = [];
    const newGallery = [];

    for (let i = 0; i < galleryItems.length; i++) {
      const item = galleryItems[i];
      const photoUrl = item.url;

      try {
        const buf = await fetchBuffer(photoUrl);
        const photoResult = await storage.upload({
          buffer: buf,
          folder: `characters/${charId}/photos`,
          filename: `${i}_${randomUUID().slice(0, 8)}.jpg`,
        });
        newPhotos.push(photoResult.url);
        newGallery.push({
          url: photoResult.url,
          caption: item.caption || "",
        });
      } catch (err) {
        console.error(` Failed to upload photo [${i}]:`, err.message);
        newPhotos.push(photoUrl);
        newGallery.push(item);
      }
    }

    // If photos is empty or has only 1, ensure at least avatar is in photos
    if (newPhotos.length === 0 && char.avatarUrl) {
      newPhotos.push(char.avatarUrl);
    }

    char.photos = newPhotos;
    char.gallery = newGallery;
    await char.save();
  }

  // 2. Migrate User Avatars
  const users = await UserModel.find({});

  for (const user of users) {
    const userId = String(user._id);
    if (user.avatarUrl && !user.avatarUrl.includes("r2.dev") && !user.avatarUrl.includes("r2.lofnchat.com") && !user.avatarUrl.includes("r2.cloudflarestorage.com")) {
    
      try {
        const buf = await fetchBuffer(user.avatarUrl);
        const result = await storage.upload({
          buffer: buf,
          folder: `users/${userId}/avatar`,
          filename: `avatar_${randomUUID().slice(0, 8)}.jpg`,
        });
        user.avatarUrl = result.url;
        user.avatarKey = result.key;
        await user.save();
      } catch (err) {
        console.error(` Failed to upload user avatar:`, err.message);
      }
    } else {
    }
  }

  // 3. Update data/characters.example.json with R2 URLs
  const maya = await CharacterModel.findOne({ slug: "maya" });
  if (maya) {
    const catalogPath = path.resolve(__dirname, "../data/characters.example.json");
    try {
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      if (Array.isArray(catalog) && catalog[0] && catalog[0].slug === "maya") {
        catalog[0].avatarUrl = maya.avatarUrl;
        catalog[0].photos = maya.photos;
        catalog[0].gallery = maya.gallery.map(g => ({ url: g.url, caption: g.caption }));
        await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
      }
    } catch (err) {
      console.warn("Could not update characters.example.json:", err.message);
    }
  }

  await disconnectDatabase();
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
