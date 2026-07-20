const Chat = require("../models/Chat");
const Message = require("../models/Message");
const cloudinary = require("../utils/cloudinary");


exports.sendMessages = async (req, res) => {
  const { chatId, senderId, content, receiverId, media, disappearDuration } = req.body;
  // console.log("body", req.body)
  // console.log("receiverId", receiverId);
  try {
    let mediaUrls = [];
// console.log("mediadata", media)
    for (const base64Data of media) {
      // console.log("base64Data", base64Data)
      const uploaded = await cloudinary.uploader.upload(base64Data, {
        folder: "gappo_chat_app", // Cloudinary folder name
        allowed_formats: ["jpg", "png", "jpeg", "gif", "mp4", "webm"],
        resource_type: "auto", // supports image & video
      });
      // console.log("uploaded", uploaded)
      mediaUrls.push(uploaded.secure_url);
    }

    // Don't calculate expiresAt now — it will be set when the receiver reads the message.
    // disappearDuration is stored on the message so we know the timer when marking as read.
    const parsedDuration =
      disappearDuration && disappearDuration > 0 ? disappearDuration : null;

    const newMessage = new Message({
      chatId,
      sender: senderId,
      receiver: receiverId,
      content,
      media: mediaUrls,
      isRead: false,
      expiresAt: null,
      disappearDuration: parsedDuration,
    });

    const savedMessage = await newMessage.save();

    await Chat.findByIdAndUpdate(chatId, { lastMessage: savedMessage._id });
    // Populate sender data
    const fullMessage = await savedMessage.populate(
      "sender",
      "_id username profilePic"
    );

    // Send the message to the receiver in real-time using Socket.io
    req.io.to(chatId.toString()).emit("newMessage", fullMessage);

    // Real-time unread count calculation & emission for receiver
    try {
      const unreadCount = await Message.countDocuments({
        sender: senderId,
        receiver: receiverId,
        isRead: false,
        $or: [
          { expiresAt: null },
          { expiresAt: { $exists: false } },
          { expiresAt: { $gt: new Date() } },
        ],
      });

      if (receiverId) {
        req.io.to(receiverId.toString()).emit("unreadMessageCountUpdated", {
          friendId: senderId,
          count: unreadCount,
        });
        req.io.to(receiverId.toString()).emit("update_unseen_count", {
          friendId: senderId,
          count: unreadCount,
        });
      }
    } catch (countErr) {
      console.error("Error calculating unread count in sendMessages:", countErr);
    }

    return res.status(200).json(fullMessage);
  } catch (error) {
    return res.status(500).json(error);
  }
};

exports.getMessages = async (req, res) => {
  try {
    // Exclude expired messages (double safety — even if MongoDB TTL hasn't cleaned up yet)
    const message = await Message.find({
      chatId: req.params.chatId,
      $or: [
        { expiresAt: null },
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    }).populate("sender", "-password");
    // console.log("getMessage", message)
    return res.status(200).json(message);
  } catch (error) {
    return res.status(500).json(error);
  }
};

exports.markMessage = async (req, res) => {
  const { senderId, receiverId } = req.body;
  try {
    // Find unread messages that we are marking as read
    const unreadMessages = await Message.find({
      sender: senderId,
      receiver: receiverId,
      isRead: false,
    });

    const now = new Date();
    const bulkOps = unreadMessages.map((msg) => {
      const update = { isRead: true };
      if (msg.disappearDuration && msg.disappearDuration > 0) {
        update.expiresAt = new Date(now.getTime() + msg.disappearDuration * 3600000);
      }
      return {
        updateOne: {
          filter: { _id: msg._id },
          update: { $set: update },
        },
      };
    });

    let result = null;
    if (bulkOps.length > 0) {
      result = await Message.bulkWrite(bulkOps);
    }

    res
      .status(200)
      .json({ message: "Messages marked as read", result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

