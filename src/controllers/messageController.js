const Chat = require("../models/Chat");
const Message = require("../models/Message");
const GroupMessage = require("../models/GroupMessage");
const cloudinary = require("../utils/cloudinary");
const { sendPushNotification } = require("../utils/webPushHelper");


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
    const fullMessage = await Message.findById(savedMessage._id).populate(
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
        deletedFor: { $ne: receiverId },
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

        // Trigger background push notification
        if (receiverId.toString() !== senderId.toString()) {
           const totalUnread = await Message.countDocuments({
            receiver: receiverId,
            isRead: false,
            deletedFor: { $ne: receiverId },
            $or: [
              { expiresAt: null },
              { expiresAt: { $exists: false } },
              { expiresAt: { $gt: new Date() } },
            ],
          });

          sendPushNotification(receiverId, {
            title: "Chugli",
            body: "New message received!",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            badgeCount: totalUnread,
            data: {
              chatId: chatId,
              senderId: senderId,
            },
          }).catch(err => console.error("Error in background push notify:", err));
        }
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
    const { userId } = req.query;
    // Exclude expired messages (double safety — even if MongoDB TTL hasn't cleaned up yet)
    const query = {
      chatId: req.params.chatId,
      $or: [
        { expiresAt: null },
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    };

    if (userId) {
      query.deletedFor = { $ne: userId };
    }

    const message = await Message.find(query).populate("sender", "-password");
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

exports.clearChat = async (req, res) => {
  const { chatId, userId } = req.body;
  if (!chatId || !userId) {
    return res.status(400).json({ message: "chatId and userId are required" });
  }

  try {
    // Attempt to clear from Message collection
    await Message.updateMany(
      { chatId },
      { $addToSet: { deletedFor: userId } }
    );

    // Attempt to clear from GroupMessage collection (chatId is the groupId in group chats)
    await GroupMessage.updateMany(
      { groupId: chatId },
      { $addToSet: { deletedFor: userId } }
    );

    return res.status(200).json({ message: "Chat cleared successfully for the user" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.deleteMessage = async (req, res) => {
  const { messageId, userId, isGroup } = req.body;
  if (!messageId || !userId) {
    return res.status(400).json({ message: "messageId and userId are required" });
  }

  try {
    const Model = isGroup ? GroupMessage : Message;
    const message = await Model.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    const ageInMs = Date.now() - new Date(message.createdAt).getTime();
    const oneHourInMs = 60 * 60 * 1000;

    if (ageInMs > oneHourInMs) {
      // Older than 1 hour -> delete only for this user
      message.deletedFor.push(userId);
      await message.save();
      return res.status(200).json({ message: "Message deleted for you." });
    } else {
      // Younger than 1 hour -> delete from both sides (completely from database)
      await Model.findByIdAndDelete(messageId);

      // Emit socket event to notify other clients in the room/group
      const room = isGroup ? message.groupId : message.chatId;
      if (room && req.io) {
        req.io.to(room.toString()).emit("messageDeleted", { messageId });
      }

      return res.status(200).json({ message: "Message deleted for everyone." });
    }
  } catch (error) {
    console.error("Error in deleteMessage controller:", error);
    return res.status(500).json({ message: error.message });
  }
};

