// const { model } = require("mongoose");
const User = require("../models/User");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const createToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

// ✅ Nodemailer setup (for verification)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // must be your app password, not real Gmail password
  },
});

const googleAuth = async (req, res) => {
  try {
    const { token } = req.body; // token from frontend (Google)
    if (!token) return res.status(400).json({ message: "No token provided" });

    // 1️⃣ Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { email, name, picture, email_verified } = ticket.getPayload();

    // 2️⃣ Ensure the Google account email is verified
    if (!email_verified) {
      return res.status(403).json({ message: "Email not verified by Google" });
    }

    // 3️⃣ Check if the user already exists
    let user = await User.findOne({ email });

    if (!user) {
      // 4️⃣ Create new user if not exist
      user = await User.create({
        username: name,
        email,
        password: "GOOGLE_AUTH_USER", // dummy password
        profilePic: picture,
        isVerified: true,
      });
    }

    // 5️⃣ Generate JWT for our app
    const appToken = createToken(user._id);

    res.status(200).json({
      message: "Google authentication successful",
      token: appToken,
      userId: user._id,
      user,
    });
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const signup = async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const userExists = await User.findOne({ email });

    if (userExists) {
      return res.status(400).json({ message: "user is already exist" });
    }

    // const user = await User.create({
    //   username,
    //   email,
    //   password,
    //   isVerified: false,
    // });

    const verifyToken = jwt.sign(
   { username, email, password },
  process.env.JWT_SECRET,
  { expiresIn: "1d" } // token valid for 1 day
);

    // const token = createToken(user._id);

    const verifyLink = `${process.env.BASE_URL}/api/auth/verify-email/${verifyToken}`;
    // Send verification email
    await transporter.sendMail({
      from: `"Chugli App" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Verify your Chugli account ✉️",
      html: `
        <div style="font-family:sans-serif; text-align:center;">
          <h2>Hi ${username},</h2>
          <p>Thanks for signing up for <b>Chugli Chat App 💬</b>.</p>
          <p>Please verify your email to activate your account:</p>
          <a href="${verifyLink}" style="background-color:#1d4ed8;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;">
            Verify My Email
          </a>
          <p style="margin-top:10px;">This link expires in 24 hours.</p>
        </div>
      `,
    });

    // jwt.sign({id: user._id}, process.env.JWT_SECRET, {
    //     expiresIn:"30d"
    // })
    res.status(201).json({ message: "user created", verifyToken });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: error.message });
  }
};


// 🧩 2️⃣ VERIFY EMAIL ROUTE
const verifyEmail = async (req, res) => {
  const { token } = req.params;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // const user = await User.findById(decoded.userId);
    const { username, email, password } = decoded;
    // if (!user) return res.status(404).send("<h2>User not found</h2>");
    // if (user.isVerified)
    //   return res.status(400).send("<h2>Email already verified</h2>");

    // user.isVerified = true;
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).send("<h2>Email already verified or user exists.</h2>");
    }

    const user = await User.create({
      username,
      email,
      password,
      isVerified: true,
    });
    await user.save();

    res.status(200).send(`
      <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
        <h2>✅ Email verified successfully!</h2>
        <p>You can now close this tab and log in to your Chugli account.</p>
      </div>
    `);
  } catch (error) {
    console.error("Email Verification Error:", error);
    res.status(400).send("<h2>❌ Invalid or expired verification link.</h2>");
  }
};

const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    // 🧩 ADD THIS CHECK HERE — before password match
    if (!user.isVerified) {
      return res.status(403).json({
        message: "Please verify your email before logging in.",
      });
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


const resendVerification = async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isVerified)
      return res.status(400).json({ message: "Email already verified" });

    const verifyToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });
    const verifyLink = `${process.env.BASE_URL}/api/auth/verify-email/${verifyToken}`;

    await transporter.sendMail({
      from: `"Chugli App" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Verify your Chugli account (Resent)",
      html: `
        <p>Hello ${user.username},</p>
        <p>Here's your new verification link:</p>
        <a href="${verifyLink}" style="background:#1d4ed8;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;">
          Verify My Email
        </a>
      `,
    });

    res
      .status(200)
      .json({ message: "Verification email resent successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to resend verification email" });
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
      return res.status(400).json({
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
      return res.status(400).json({
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

module.exports = { signup,
  login,
  changePassword,
  googleAuth,
  verifyEmail,
  resendVerification, };
