const Chat = require("../models/Chat");
const Message = require("../models/Message");

exports.createChat = async (req, res) => {
  const [userId, recipientId] = req.body;
console.log(req.body)
  try {
    let chat;
    if (userId === recipientId) {
      // For self-chat, look for a chat of size 2 where both elements are userId
      chat = await Chat.findOne({
        members: { $size: 2 },
        $and: [
          { "members.0": userId },
          { "members.1": userId }
        ]
      });
    } else {
      // For standard 1-1 chat, look for a chat of size 2 containing both user IDs
      chat = await Chat.findOne({
        members: {
          $size: 2,
          $all: [userId, recipientId],
        },
      });
    }

    if (chat) {
      return res.status(200).json(chat);
    }
    const newChat = new Chat({
      members: [userId, recipientId],
    });
    const savedChat = await newChat.save();
    return res.status(200).json(savedChat);
  } catch (error) {
    return res.status(500).json(error);
  }
};

exports.getUserChats = async (req, res) => {
  try {
    const chat = await Chat.find({
      members: { $in: [req.params.userId] },
    }).populate("members", "-password");
    console.log("chat", chat)
    return res.status(200).json(chat);
  } catch (error) {
    return res.status(500).json(error);
  }
};
