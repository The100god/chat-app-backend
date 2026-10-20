const mongoose = require("mongoose");
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

async function runMigration() {
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/chat-app";
  console.log("Connecting to MongoDB for username & name migration...", mongoUri);
  await mongoose.connect(mongoUri);

  const db = mongoose.connection.db;
  const usersCollection = db.collection("users");

  const users = await usersCollection.find({}).toArray();
  console.log(`Found ${users.length} users to inspect and migrate.`);

  const usedUsernames = new Set();

  for (const user of users) {
    const rawUsername = user.username || "";
    // If name is already set, keep it; otherwise use the raw username
    const displayName = (user.name && user.name.trim()) ? user.name.trim() : rawUsername.trim();

    // Normalization rule: lowercase, strip all spaces, strip characters not in [a-z0-9_]
    // Example: "anime lover" -> "animelover"
    let cleanUsername = rawUsername.toLowerCase().trim().replace(/\s+/g, "").replace(/[^a-z0-9_]/g, "");

    if (cleanUsername.length < 3) {
      cleanUsername = cleanUsername.padEnd(3, "_");
    }
    if (cleanUsername.length > 30) {
      cleanUsername = cleanUsername.substring(0, 30);
    }

    // Handle collision if needed
    let finalUsername = cleanUsername;
    let counter = 1;
    while (usedUsernames.has(finalUsername)) {
      finalUsername = `${cleanUsername.substring(0, 27)}${counter}`;
      counter++;
    }
    usedUsernames.add(finalUsername);

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          name: displayName,
          username: finalUsername,
        },
      }
    );

    console.log(`Migrated User [${user._id}]:`);
    console.log(`  Raw: "${rawUsername}" -> Name: "${displayName}" | Username: "${finalUsername}"`);
  }

  // Ensure unique index on username
  try {
    const indexes = await usersCollection.indexes();
    const hasUsernameIndex = indexes.some((idx) => idx.name === "username_1");
    if (!hasUsernameIndex) {
      await usersCollection.createIndex(
        { username: 1 },
        { unique: true, collation: { locale: "en", strength: 2 }, name: "username_1" }
      );
      console.log("Created case-insensitive unique index on 'username'.");
    }
  } catch (idxErr) {
    console.warn("Index check note:", idxErr.message);
  }

  console.log("Migration completed successfully!");
  await mongoose.disconnect();
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

module.exports = runMigration;
