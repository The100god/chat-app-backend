const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema({
  // Permanent unique public handle
  username: {
    type: String,
    required: [true, "Username is required"],
    unique: true,
    trim: true,
    lowercase: true,
    match: [
      /^[a-z0-9_]{3,30}$/,
      "Username must be 3-30 characters long and contain only letters, numbers, and underscores.",
    ],
    immutable: true, // Schema-level immutability
  },
  // Editable display name
  name: {
    type: String,
    required: [true, "Display name is required"],
    trim: true,
    minlength: [1, "Display name must be at least 1 character long"],
    maxlength: [50, "Display name cannot exceed 50 characters"],
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  about: {
    type: String,
    default: "Hey there! I am using Chugli 💬",
    maxlength: 150,
  },
  profilePic: {
    type: String,
    default:
      "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR0hKWzEg5DKQttwLus5tvIqozRQL-BKXF9EQ&s",
  },
  friends: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  friendRequests: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  isVerified: { type: Boolean, default: false },
  isSuspended: { type: Boolean, default: false },
  suspendedReason: { type: String, default: "" },
  pushSubscriptions: [
    {
      endpoint: { type: String, required: true },
      expirationTime: { type: String },
      keys: {
        p256dh: { type: String, required: true },
        auth: { type: String, required: true },
      },
    },
  ],
});

// Enforce username immutability on document save
UserSchema.pre("save", async function (next) {
  if (!this.isNew && this.isModified("username")) {
    return next(new Error("Username is permanent and cannot be modified."));
  }

  if (!this.isModified("password")) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Enforce username immutability on direct query updates
UserSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
  const update = this.getUpdate();
  if (update) {
    if (
      update.username !== undefined ||
      (update.$set && update.$set.username !== undefined)
    ) {
      return next(new Error("Username is permanent and cannot be modified."));
    }
  }
  next();
});

UserSchema.methods.matchPassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model("User", UserSchema);