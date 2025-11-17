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
  // service: "gmail",
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
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

    if (user) {
      if (!user.isVerified) {
        user.isVerified = true;
      }

      // If old user does not have self-friend, fix it
      if (!user.friends.includes(user._id)) {
        user.friends.push(user._id);
      }

      await user.save();
    } else {
      // Create new user only if none exists
      user = await User.create({
        username: name,
        email,
        password: "GOOGLE_AUTH_USER",
        profilePic: picture,
        isVerified: true,
      });

      // MAKE USER FRIEND OF HIMSELF
      user.friends = [user._id];
      await user.save();
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
      { expiresIn: "1h" } // token valid for 1 day
    );

    // const token = createToken(user._id);

    // Verification link
    const verifyLink = `${process.env.BASE_URL}/api/auth/verify-email/${verifyToken}`;

    // Verify transporter configuration
    await transporter.verify();

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

    res.status(201).json({ message: "Please check your email to verify your account."});
  } catch (error) {
    // console.error("Signup error:", error);
    res.status(500).json({ message: error.message });
  }
};

// 🧩 2️⃣ VERIFY EMAIL ROUTE
const verifyEmail = async (req, res) => {
  const { token } = req.params;
  try {
    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Extract username, email, and password from the decoded token
    const { username, email, password } = decoded;

    // Check if user already exists
    const existingUser = await User.findOne({ email });

    // If user exists and is verified, redirect to frontend with info
    if (existingUser && existingUser.isVerified) {
      console.log("⚠️ User already verified:", email);
      // Redirect to frontend with info
      return res.redirect(
        `${process.env.CLIENT_URL}/pages/login?verified=already`
      );
    }

    // If user doesn’t exist → create verified user
    if (!existingUser) {
      existingUser = await User.create({
        username,
        email,
        password,
        isVerified: true,
      });

      // MAKE USER FRIEND OF HIMSELF
      existingUser.friends = [existingUser._id];
      await existingUser.save();

      console.log("✅ Created verified user:", email);
    } else {
      // Update existing record to verified
      existingUser.isVerified = true;
      // FIX MISSING SELF-FRIEND
      if (!existingUser.friends.includes(existingUser._id)) {
        existingUser.friends.push(existingUser._id);
      }
      await existingUser.save();
      console.log("✅ Marked existing user as verified:", email);
    }

    // Create JWT token for login
    const appToken = createToken(existingUser._id);

    // Redirect user to frontend with token (auto-login)
    const redirectURL = `${process.env.CLIENT_URL}/?token=${appToken}`;

    console.log("🔗 Redirecting user to:", redirectURL);
    return res.status(302).redirect(redirectURL);

  } catch (error) {
    // console.error("Email Verification Error:", error);
    if (!res.headersSent) {
      res.status(302).redirect(
        `${process.env.CLIENT_URL}/pages/login?verified=failed`
      );
    }
  }
};

const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    // ADD THIS CHECK HERE — before password match
    if (!user.isVerified) {
      return res.status(403).json({
        message: "Please verify your email before logging in.",
      });
    }

    // Check if password matches
    const matches = await user.matchPassword(password);
    if (!matches) {
      return res.status(400).json({ message: "Invalid User Details" });
    }

    // FIX MISSING SELF-FRIEND
    if (!user.friends.includes(user._id)) {
      user.friends.push(user._id);
      await user.save();
    }

    // Create JWT token
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
    // Find user by email
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    // Check if already verified
    if (user.isVerified)
      return res.status(400).json({ message: "Email already verified" });

    // Create new verification token
    const verifyToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    // Verification link
    const verifyLink = `${process.env.BASE_URL}/api/auth/verify-email/${verifyToken}`;

    // Verify transporter configuration
    await transporter.verify();

    // Send verification email
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

    // Return success message
    res
      .status(200)
      .json({ message: "Verification email resent successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to resend verification email" });
  }
};

const changePassword = async (req, res) => {
  try {
    // get user id from auth middleware
    const userId = req.user._id;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    // validate input
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res
        .status(400)
        .json({ message: "Please provide all required fields" });
    }

    // check if new password and confirm password match
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

    // fetch user from DB
    const user = await User.findById(userId).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    // check if old password matches
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

module.exports = {
  signup,
  login,
  changePassword,
  googleAuth,
  verifyEmail,
  resendVerification,
};
