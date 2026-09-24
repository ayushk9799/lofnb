import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { UserModel } from "../src/models/user.model.js";
import { MessageModel } from "../src/models/message.model.js";

const R2_DEV_REGEX = /https?:\/\/[a-zA-Z0-9.\-_]+\.r2\.dev/g;
const TARGET_CDN_URL = "https://r2.lofnchat.com";

function migrateUrl(url) {
  if (typeof url !== "string") return url;
  return url.replace(R2_DEV_REGEX, TARGET_CDN_URL);
}

async function migrate() {
 

  await connectDatabase(env.MONGODB_URI);

  try {
    // 1. Migrate Characters
    const characters = await CharacterModel.find({
      $or: [
        { avatarUrl: { $regex: "r2\\.dev" } },
        { photos: { $regex: "r2\\.dev" } },
        { "gallery.url": { $regex: "r2\\.dev" } },
      ],
    });


    let migratedCharacters = 0;
    for (const char of characters) {
      let modified = false;

      if (char.avatarUrl && R2_DEV_REGEX.test(char.avatarUrl)) {
        char.avatarUrl = migrateUrl(char.avatarUrl);
        modified = true;
      }

      if (Array.isArray(char.photos)) {
        const updatedPhotos = char.photos.map((p) => migrateUrl(p));
        if (JSON.stringify(updatedPhotos) !== JSON.stringify(char.photos)) {
          char.photos = updatedPhotos;
          modified = true;
        }
      }

      if (Array.isArray(char.gallery)) {
        let galleryModified = false;
        char.gallery = char.gallery.map((item) => {
          if (item?.url && R2_DEV_REGEX.test(item.url)) {
            galleryModified = true;
            return {
              ...item.toObject ? item.toObject() : item,
              url: migrateUrl(item.url),
            };
          }
          return item;
        });
        if (galleryModified) modified = true;
      }

      if (modified) {
        await char.save();
        migratedCharacters++;
      }
    }

    // 2. Migrate Users
    const users = await UserModel.find({
      avatarUrl: { $regex: "r2\\.dev" },
    });


    let migratedUsers = 0;
    for (const user of users) {
      if (user.avatarUrl && R2_DEV_REGEX.test(user.avatarUrl)) {
        user.avatarUrl = migrateUrl(user.avatarUrl);
        await user.save();
        migratedUsers++;
      }
    }

    // 3. Migrate Messages (mediaUrl / mediaMeta.speechUrl)
    const messages = await MessageModel.find({
      $or: [
        { mediaUrl: { $regex: "r2\\.dev" } },
        { "mediaMeta.speechUrl": { $regex: "r2\\.dev" } },
      ],
    });


    let migratedMessages = 0;
    for (const msg of messages) {
      let modified = false;
      if (msg.mediaUrl && R2_DEV_REGEX.test(msg.mediaUrl)) {
        msg.mediaUrl = migrateUrl(msg.mediaUrl);
        modified = true;
      }
      if (msg.mediaMeta?.speechUrl && R2_DEV_REGEX.test(msg.mediaMeta.speechUrl)) {
        msg.mediaMeta.speechUrl = migrateUrl(msg.mediaMeta.speechUrl);
        modified = true;
      }
      if (modified) {
        await msg.save();
        migratedMessages++;
      }
    }

  } finally {
    await disconnectDatabase();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
