import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { StorageService } from "../src/services/storage.service.js";

// Curated royalty-free portrait templates from Unsplash
const TEMPLATE_MALE_URLS = [
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&q=80",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800&q=80",
  "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=800&q=80",
  "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=800&q=80",
  "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=800&q=80",
  "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=800&q=80",
  "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=800&q=80",
  "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=800&q=80",
  "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?w=800&q=80",
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&q=80",
];

const TEMPLATE_FEMALE_URLS = [
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&q=80",
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&q=80",
  "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&q=80",
  "https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=800&q=80",
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800&q=80",
  "https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=800&q=80",
  "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=800&q=80",
  "https://images.unsplash.com/photo-1499952127939-9bbf5af6c51c?w=800&q=80",
  "https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=800&q=80",
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&q=80",
];

const TEMPLATE_GALLERY_URLS = [
  "https://images.unsplash.com/photo-1511632765486-a01980e01a18?w=800&q=80",
  "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800&q=80",
  "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&q=80",
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=80",
  "https://images.unsplash.com/photo-1517048676732-d65bc937f952?w=800&q=80",
];

const MALE_NAMES = [
  "Liam Miller", "Noah Anderson", "Oliver Wright", "Lucas Vance", "Ethan Cole",
  "Leo Martinez", "Benjamin Brooks", "Julian Hayes", "Daniel Foster", "Theo Clark",
  "Gabriel Scott", "Alexander Lee", "James Evans", "Henry Walker", "Elijah Price",
  "Sebastian Kelly", "Jackson Ross", "Mateo Silva", "Aiden Cooper", "Ryan Hughes",
  "Miles Davis", "Caleb Ortiz", "Isaac Morgan", "Christian Bell", "Mason Bennett",
  "Logan Richardson", "Nathan Wood", "Aaron Jenkins", "Isaiah Ward", "Connor Diaz",
  "Eli Russell", "Dylan Simmons", "Jordan Foster", "Dominic Griffin", "Ezra Butler",
  "Hunter Flores", "Adrian Powell", "Roman Perry", "Evan Henderson", "Cole Bryant",
  "Austin Griffin", "Justin West", "Brandon Alexander", "Xavier Hayes", "Parker Sullivan",
  "Silas Murphy", "Ian Walsh", "Tristan Campbell", "Gavin Reed", "Sean O'Connor"
];

const FEMALE_NAMES = [
  "Sophia Reed", "Emma Bennett", "Olivia Hayes", "Ava Carter", "Isabella Flores",
  "Mia Sullivan", "Charlotte Evans", "Amelia Ross", "Harper Brooks", "Evelyn Ward",
  "Abigail Turner", "Emily Diaz", "Elizabeth Watson", "Mila Howard", "Ella Ramirez",
  "Avery Patterson", "Sofia Jenkins", "Camila Barnes", "Scarlett Coleman", "Victoria Powell",
  "Madison Kelly", "Luna Murphy", "Grace Hughes", "Penelope Sanders", "Layla Bennett",
  "Riley Morris", "Zoey Morales", "Nora Richardson", "Lily Cox", "Eleanor Howard",
  "Hannah Ward", "Lillian Torres", "Addison Peterson", "Aubrey Gray", "Ellie Ramirez",
  "Stella James", "Natalie Watson", "Zoe Brooks", "Leah Kelly", "Hazel Sanders",
  "Violet Price", "Aurora Bennett", "Savannah Wood", "Audrey Barnes", "Brooklyn Ross",
  "Bella Henderson", "Claire Coleman", "Skylar Jenkins", "Serena Vance", "Maya Sinclair"
];

const OCCUPATIONS = [
  "Architectural Designer", "Full Stack Engineer", "Landscape Photographer",
  "Specialty Coffee Roaster", "Neuroscience Researcher", "Creative Director",
  "Urban Farm Coordinator", "Botanical Illustrator", "Indie Game Developer",
  "Sommelier & Wine Buyer", "Ceramic Sculptor", "Environmental Attorney",
  "UX/UI Lead", "Documentary Filmmaker", "Acoustic Audio Engineer",
  "Marine Conservationist", "Interior Stylist", "Sports Nutritionist",
  "Fintech Product Manager", "Astronomy Lecturer"
];

const LOCATIONS = [
  "New York, NY", "San Francisco, CA", "Seattle, WA", "Austin, TX",
  "Chicago, IL", "London, UK", "Tokyo, Japan", "Berlin, Germany",
  "Toronto, Canada", "Sydney, Australia", "Paris, France", "Denver, CO",
  "Portland, OR", "Boston, MA", "Amsterdam, Netherlands"
];

const VIBE_TRAIT_SETS = [
  ["Chill", "curious", "thoughtful", "easygoing"],
  ["Creative", "imaginative", "artistic", "expressive"],
  ["Ambitious", "driven", "focused", "visionary"],
  ["Outgoing", "charismatic", "spontaneous", "playful"],
  ["Intellectual", "analytical", "philosophical", "deep"],
  ["Romantic", "empathetic", "warm", "attentive"],
  ["Adventurous", "bold", "outdoorsy", "energetic"],
  ["Witty", "sarcastic", "candid", "charming"]
];

const HOBBY_POOLS = [
  ["specialty pourover coffee", "vintage film photography", "urban bouldering", "reading indie sci-fi"],
  ["ceramic pottery", "weekend farmers markets", "natural wine tastings", "collecting vinyl records"],
  ["trail running", "baking sourdough", "attending synthwave gigs", "board game nights"],
  ["scuba diving", "landscape watercolor", "podcast hosting", "cozy book hunting"],
  ["rock climbing", "crafting cocktails", "museum wandering", "cooking homemade pasta"]
];

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadTemplates(storage) {
  const maleTemplateUrls = [];
  const femaleTemplateUrls = [];
  const galleryTemplateUrls = [];

  // 1. Male templates
  for (let i = 0; i < TEMPLATE_MALE_URLS.length; i++) {
    const filename = `male_${String(i + 1).padStart(2, "0")}.jpg`;
    const folder = "templates/portraits";
    const key = `${folder}/${filename}`;
    const expectedUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
    try {
      const buf = await fetchBuffer(TEMPLATE_MALE_URLS[i]);
      const res = await storage.upload({ buffer: buf, folder, filename });
      maleTemplateUrls.push(res.url);
    } catch (err) {
      console.warn(`   Notice: Using fallback or existing url for ${key}: ${err.message}`);
      maleTemplateUrls.push(expectedUrl);
    }
  }

  // 2. Female templates
  for (let i = 0; i < TEMPLATE_FEMALE_URLS.length; i++) {
    const filename = `female_${String(i + 1).padStart(2, "0")}.jpg`;
    const folder = "templates/portraits";
    const key = `${folder}/${filename}`;
    const expectedUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
    try {
      const buf = await fetchBuffer(TEMPLATE_FEMALE_URLS[i]);
      const res = await storage.upload({ buffer: buf, folder, filename });
      femaleTemplateUrls.push(res.url);
    } catch (err) {
      console.warn(`   Notice: Using fallback or existing url for ${key}: ${err.message}`);
      femaleTemplateUrls.push(expectedUrl);
    }
  }

  // 3. Gallery templates
  for (let i = 0; i < TEMPLATE_GALLERY_URLS.length; i++) {
    const filename = `gallery_${String(i + 1).padStart(2, "0")}.jpg`;
    const folder = "templates/gallery";
    const key = `${folder}/${filename}`;
    const expectedUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
    try {
      const buf = await fetchBuffer(TEMPLATE_GALLERY_URLS[i]);
      const res = await storage.upload({ buffer: buf, folder, filename });
      galleryTemplateUrls.push(res.url);
    } catch (err) {
      console.warn(`   Notice: Using fallback or existing url for ${key}: ${err.message}`);
      galleryTemplateUrls.push(expectedUrl);
    }
  }

  return { maleTemplateUrls, femaleTemplateUrls, galleryTemplateUrls };
}

function buildCharacterList({ maleTemplateUrls, femaleTemplateUrls, galleryTemplateUrls }) {
  const characters = [];

  // Build 50 Male characters
  for (let i = 0; i < 50; i++) {
    const index = i + 1;
    const slug = `sim-male-${String(index).padStart(2, "0")}`;
    const name = MALE_NAMES[i];
    const age = 21 + (i % 18); // Ages 21 to 38
    const avatarUrl = maleTemplateUrls[i % maleTemplateUrls.length];
    const galleryUrl = galleryTemplateUrls[i % galleryTemplateUrls.length];
    const traits = VIBE_TRAIT_SETS[i % VIBE_TRAIT_SETS.length];
    const occupation = OCCUPATIONS[i % OCCUPATIONS.length];
    const location = LOCATIONS[i % LOCATIONS.length];
    const hobbies = HOBBY_POOLS[i % HOBBY_POOLS.length];

    characters.push({
      slug,
      name,
      age,
      gender: "male",
      timezone: "America/New_York",
      avatarUrl,
      photos: [avatarUrl, galleryUrl],
      gallery: [
        { url: avatarUrl, caption: "Profile portrait" },
        { url: galleryUrl, caption: "Out and about exploring the city" }
      ],
      ethnicity: "Diverse",
      occupation,
      location,
      hobbies,
      persona: {
        summary: `Hey! I'm ${name.split(" ")[0]}. Working as an ${occupation} based in ${location}. Always down for good coffee, deep conversations, and spontaneous weekend trips.`,
        personalityTraits: traits,
        values: ["honesty", "curiosity", "kindness"],
        likes: ["great coffee", "live music", "meaningful conversations", "sunset strolls"],
        dislikes: ["dishonesty", "being hurried", "cold rainy days without blankets"],
        boundaries: ["Clear communication and mutual respect are essential to me."]
      },
      conversationalStyle: {
        messageLength: i % 2 === 0 ? "balanced" : "short",
        emojiUsage: "light",
        capitalization: "standard",
        slang: ["tbh", "totally", "for sure"],
        petNames: []
      },
      backstory: {
        summary: `Grew up traveling between different cities before settling down in ${location}. Focused on my craft as an ${occupation} and looking for authentic connections.`,
        friends: ["Marcus, longtime hiking buddy", "Dave, studio partner"],
        importantEvents: ["Moved into my new loft", "Completed my first major portfolio show"],
        canonicalFacts: [`Based in ${location}`, `Works as an ${occupation}`, `Favorite drink is black drip coffee`],
        pastRelationships: "Ended a long-term relationship mutually when life goals diverged. Ready for a new chapter."
      },
      matchProbability: 1,
      version: 1
    });
  }

  // Build 50 Female characters
  for (let i = 0; i < 50; i++) {
    const index = i + 1;
    const slug = `sim-female-${String(index).padStart(2, "0")}`;
    const name = FEMALE_NAMES[i];
    const age = 20 + (i % 18); // Ages 20 to 37
    const avatarUrl = femaleTemplateUrls[i % femaleTemplateUrls.length];
    const galleryUrl = galleryTemplateUrls[i % galleryTemplateUrls.length];
    const traits = VIBE_TRAIT_SETS[(i + 3) % VIBE_TRAIT_SETS.length];
    const occupation = OCCUPATIONS[(i + 5) % OCCUPATIONS.length];
    const location = LOCATIONS[(i + 4) % LOCATIONS.length];
    const hobbies = HOBBY_POOLS[(i + 2) % HOBBY_POOLS.length];

    characters.push({
      slug,
      name,
      age,
      gender: "female",
      timezone: "America/New_York",
      avatarUrl,
      photos: [avatarUrl, galleryUrl],
      gallery: [
        { url: avatarUrl, caption: "Profile portrait" },
        { url: galleryUrl, caption: "Golden hour in the neighborhood" }
      ],
      ethnicity: "Diverse",
      occupation,
      location,
      hobbies,
      persona: {
        summary: `Hi there! I'm ${name.split(" ")[0]}. ${occupation} by day, creative explorer by night. Let's trade favorite playlists and find the best hidden matcha spots in town.`,
        personalityTraits: traits,
        values: ["authenticity", "creativity", "empathy"],
        likes: ["art exhibits", "matcha lattes", "spontaneous roadtrips", "indie bookstore finds"],
        dislikes: ["pretentiousness", "bad grammar", "leaving without saying goodbye"],
        boundaries: ["I value open, non-judgmental dialogue and clear emotional boundaries."]
      },
      conversationalStyle: {
        messageLength: "balanced",
        emojiUsage: i % 2 === 0 ? "light" : "frequent",
        capitalization: i % 3 === 0 ? "lowercase" : "standard",
        slang: ["lowkey", "obsessed", "tbh"],
        petNames: []
      },
      backstory: {
        summary: `Originally from a quiet coastal town, I moved to ${location} to pursue my passion as an ${occupation}. When not working, I love exploring local art scenes.`,
        friends: ["Chloe, fellow gallery enthusiast", "Sam, favorite travel companion"],
        importantEvents: ["Published my first independent creative zine", "Adopted an energetic shelter puppy"],
        canonicalFacts: [`Based in ${location}`, `Works as an ${occupation}`, `Favorite beverage is ceremonial matcha`],
        pastRelationships: "Took time after my last relationship to focus on my personal projects and growth."
      },
      matchProbability: 1,
      version: 1
    });
  }

  return characters;
}

async function main() {
 

  const storage = new StorageService(env);
  if (!storage.isR2Configured()) {
    throw new Error("Cloudflare R2 is not configured properly in env!");
  }

  // 1. Upload Template Images to R2
  const templates = await uploadTemplates(storage);

  // 2. Build Character Specs
  const characterSpecs = buildCharacterList(templates);

  // 3. Connect to Database & Upsert
  await connectDatabase(env.MONGODB_URI);

  let createdCount = 0;
  let updatedCount = 0;

  for (const spec of characterSpecs) {
    const existing = await CharacterModel.findOne({ slug: spec.slug }).select("_id").lean();
    await CharacterModel.findOneAndUpdate(
      { slug: spec.slug },
      { $set: spec },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (existing) {
      updatedCount++;
    } else {
      createdCount++;
    }
  }


  // 4. Verify Database Counts
  const totalCount = await CharacterModel.countDocuments();
  const maleCount = await CharacterModel.countDocuments({ gender: "male" });
  const femaleCount = await CharacterModel.countDocuments({ gender: "female" });

 

  // 5. Test Sample Cursor Query
  const firstBatch = await CharacterModel.find({ gender: "female" })
    .sort({ _id: 1 })
    .limit(20)
    .select("name slug age gender avatarUrl")
    .lean();


  // Sample Next Page Seek
  const nextBatch = await CharacterModel.find({
    gender: "female",
    _id: { $gt: firstBatch.at(-1)._id }
  })
    .sort({ _id: 1 })
    .limit(20)
    .select("name slug age")
    .lean();

 
  await disconnectDatabase();
  process.exit(0);
}

main().catch(err => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
