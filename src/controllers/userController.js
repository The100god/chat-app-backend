const mongoose = require("mongoose");
const User = require("../models/User");
const cloudinary = require("../utils/cloudinary");

// Search users by username or display name (returns all users if query is empty)
const searchUsersByUsername = async (req, res) => {
  const { username, userId } = req.query;

  if (
    !userId ||
    userId === "null" ||
    userId === "undefined" ||
    !mongoose.Types.ObjectId.isValid(userId)
  ) {
    return res.status(400).json({ message: "Missing or invalid user ID" });
  }
  try {
    const currentUser = await User.findById(userId).populate("friends", "_id");
    const friendIds = currentUser ? currentUser.friends.map((f) => f._id.toString()) : [];

    const query = {
      _id: { $ne: userId, $nin: friendIds },
    };

    if (username && username.trim() !== "") {
      const escaped = username.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      query.$or = [
        { username: { $regex: escaped, $options: "i" } },
        { name: { $regex: escaped, $options: "i" } },
      ];
    }

    const users = await User.find(query).select("_id username name profilePic about");
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ✅ Get logged-in user profile
const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ✅ Update logged-in user profile
const updateUserProfile = async (req, res) => {
  try {
    const { username, name, about, profilePic } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) return res.status(404).json({ message: "User not found" });

    // Reject attempt to modify permanent username
    if (username && username.toLowerCase().trim() !== user.username.toLowerCase().trim()) {
      return res.status(400).json({
        message: "Username is permanent and cannot be modified.",
      });
    }

    // Allow updating display name
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Display name cannot be empty." });
      }
      if (trimmedName.length > 50) {
        return res.status(400).json({ message: "Display name cannot exceed 50 characters." });
      }
      user.name = trimmedName;
    }

    if (about !== undefined) user.about = about;

    // 📸 If the profilePic is a base64 image, upload it to Cloudinary
    if (profilePic && profilePic.startsWith("data:")) {
      const uploaded = await cloudinary.uploader.upload(profilePic, {
        folder: "gappo_chat_app",
        allowed_formats: ["jpg", "png", "jpeg", "gif"],
        resource_type: "image",
      });
      user.profilePic = uploaded.secure_url;
    } 
    // 🖼 If it’s already a URL, just save it directly
    else if (profilePic) {
      user.profilePic = profilePic;
    }
    await user.save();

    res.status(200).json({
      message: "Profile updated successfully",
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        about: user.about,
        profilePic: user.profilePic,
      },
    });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ❌ Delete user account and all related data
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;

    // Remove user from all friends' friend lists
    await User.updateMany(
      { friends: userId },
      { $pull: { friends: userId } }
    );

    // Remove user from all friend request lists
    await User.updateMany(
      { friendRequests: userId },
      { $pull: { friendRequests: userId } }
    );

    // Delete all friendships involving this user
    const Friendship = require("../models/Friendship");
    await Friendship.deleteMany({
      $or: [{ user1: userId }, { user2: userId }],
    });

    // Delete all messages sent or received by this user
    const Message = require("../models/Message");
    await Message.deleteMany({
      $or: [{ senderId: userId }, { receiverId: userId }],
    });

    // Remove user from groups
    const Group = require("../models/Group");
    await Group.updateMany(
      { members: userId },
      { $pull: { members: userId } }
    );

    // Delete groups created by this user (optional — keeps groups alive if others are in them)
    await Group.deleteMany({ createdBy: userId, members: { $size: 0 } });

    // Delete the user
    await User.findByIdAndDelete(userId);

    res.status(200).json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Push Subscription controllers
const subscribePush = async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ message: "Subscription with endpoint is required." });
  }

  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Check if subscription endpoint already exists to avoid duplicates
    const exists = user.pushSubscriptions.some(
      (sub) => sub.endpoint === subscription.endpoint
    );

    if (!exists) {
      user.pushSubscriptions.push(subscription);
      await user.save();
    }

    res.status(200).json({ message: "Successfully subscribed to push notifications" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const unsubscribePush = async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ message: "Endpoint is required to unsubscribe." });
  }

  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.pushSubscriptions = user.pushSubscriptions.filter(
      (sub) => sub.endpoint !== endpoint
    );
    await user.save();

    res.status(200).json({ message: "Successfully unsubscribed from push notifications" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getVapidPublicKey = async (req, res) => {
  res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
};

module.exports = {
  searchUsersByUsername,
  getUserProfile,
  updateUserProfile,
  deleteAccount,
  subscribePush,
  unsubscribePush,
  getVapidPublicKey,
};
