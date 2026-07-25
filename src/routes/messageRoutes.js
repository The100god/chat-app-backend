const express = require("express");
const router = express.Router();

const {sendMessages, getMessages, markMessage, clearChat, deleteMessage} = require("../controllers/messageController");
// const upload = require("../middleware/upload");

// router.post("/", upload.array("media"), sendMessages);
router.post("/", sendMessages);
router.post("/clear-chat", clearChat);
router.post("/delete-message", deleteMessage);
router.get("/:chatId", getMessages)
router.put("/mark-read", markMessage) 


module.exports = router

