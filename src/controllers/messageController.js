const Chat = require("../models/Chat");
const Message = require("../models/Message");
const cloudinary = require("../utils/cloudinary");


exports.sendMessages = async (req, res) => {
  const { chatId, senderId, content, receiverId, media } = req.body;
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

    const newMessage = new Message({
      chatId,
      sender: senderId,
      receiver: receiverId,
      content,
      media: mediaUrls,
      isRead: false,
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
    console.log("fullMessage", fullMessage);
    return res.status(200).json(fullMessage);
  } catch (error) {
    return res.status(500).json(error);
  }
};

exports.getMessages = async (req, res) => {
  try {
    const message = await Message.find({
      chatId: req.params.chatId,
    }).populate("sender", "-password");
    // console.log("getMessage", message)
    return res.status(200).json(message);
  } catch (error) {
    return res.status(500).json(error);
  }
};

exports.markMessage = async (req, res) => {
  const { senderId, receiverId } = req.body;
  // console.log("mes", Message.findById(receiverId))
  try {
    const result = await Message.updateMany(
      { sender: senderId, receiver: receiverId, isRead: false },
      { $set: { isRead: true } }
    );
    // console.log("result", result)
    res
      .status(200)
      .json({ message: "Messages marked as read", result: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
