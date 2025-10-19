const Chat = require("../models/Chat");
const Message = require("../models/Message");

exports.createChat = async (req, res) => {
  const [userId, recipientId] = req.body;
console.log(req.body)
  try {
    const chat = await Chat.findOne({
      members: {
        $all: [userId, recipientId],
      },
    });
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
