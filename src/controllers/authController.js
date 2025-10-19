const { model } = require("mongoose");
const User = require("../models/User");
const jwt = require("jsonwebtoken");

const createToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

const signup = async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const userExists = await User.findOne({ email });

    if (userExists) {
      return res.status(400).json({ message: "user is already exist" });
    }

    const user = await User.create({
      username,
      email,
      password,
    });

    const token = createToken(user._id);

    // jwt.sign({id: user._id}, process.env.JWT_SECRET, {
    //     expiresIn:"30d"
    // })
    res.status(201).json({ message: "user created", token, userId: user._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    const matches = await user.matchPassword(password);
    if (!matches) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    const token = createToken(user._id);
    //  jwt.sign({id: user._id}, process.env.JWT_SECRET, {
    //     expiresIn:"30d"
    // })
    res
      .status(200)
      .json({ message: "Login Successfully", token, userId: user._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const changePassword = async (req, res) => {
  try {
    const userId = req.user._id;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return res
        .status(400)
        .json({ message: "Please provide all required fields" });
    }

    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ message: "New password and confirm password do not match" });
    }

    // Password strength validation (at least 6 characters, including letters and numbers and special characters)
    const passwordRegex =
      /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{6,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res
        .status(400)
        .json({
          message:
            "Password must be at least 6 characters long and include letters, numbers, and special characters.",
        });
    }

    const user = await User.findById(userId).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await user.matchPassword(oldPassword);
    if (!isMatch) {
      return res.status(401).json({ message: "Old password is incorrect" });
    }

    // prevernting reuse of old password
    if (oldPassword === newPassword) {
      return res
        .status(400)
        .json({
          message: "New password must be different from the old password",
        });
    }
    //set new password (pre-save hook will hash it)
    user.password = newPassword;
    await user.save();

    // optionally issue a new token so client can replace stored token
    const token = createToken(user._id);
    res.status(200).json({ message: "password changed successfully", token });
  } catch (error) {
    console.log("change password error", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { signup, login, changePassword };
