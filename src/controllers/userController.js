// controllers/userController.js
const User = require("../models/User");
const cloudinary = require("../utils/cloudinary");

// Search users by username
const searchUsersByUsername = async (req, res) => {
  const { username, userId } = req.query;

  if (!username || !userId){
    return res.status(400).json({message:"Missing search term or user ID"})
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

module.exports = { searchUsersByUsername, getUserProfile, updateUserProfile };
