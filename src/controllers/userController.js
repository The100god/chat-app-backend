const mongoose = require("mongoose");
const User = require("../models/User");
const cloudinary = require("../utils/cloudinary");

// Search users by username
const searchUsersByUsername = async (req, res) => {
  const { username, userId } = req.query;

  if (
    !username ||
    !userId ||
    userId === "null" ||
    userId === "undefined" ||
    !mongoose.Types.ObjectId.isValid(userId)
  ) {
    return res.status(400).json({ message: "Missing or invalid search term or user ID" });
  }
  try {
    const currentUser = await User.findById(userId).populate("friends", "_id");
    const friendIds = currentUser.friends.map((f)=>f._id.toString());

    const users = await User.find({ username: { $regex: username, $options: "i" },
    _id:{$ne:userId, $nin:friendIds} })
      .select("_id username profilePic");
      // .limit(10); // Limit the number of users shown to 10
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
    const { username, about, profilePic } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) return res.status(404).json({ message: "User not found" });

    if (username) user.username = username;
    if (about) user.about = about;

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

module.exports = { searchUsersByUsername, getUserProfile, updateUserProfile, deleteAccount };
