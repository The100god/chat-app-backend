const Group = require("../models/Group");
const GroupMessage = require("../models/GroupMessage");
const cloudinary = require("../utils/cloudinary");

const CreateGroup = async (req, res) => {
  const { groupName, groupProfilePic, groupMember, admins, superAdmin } =
    req.body;

  try {
    const groupExists = await Group.findOne({ groupName });

    if (groupExists) {
      return res.status(400).json({
        message: `Group of ${groupName} is already exists!`,
      });
    }

    let uploadedUrl = "";

    if (groupProfilePic) {
      const uploaded = await cloudinary.uploader.upload(groupProfilePic, {
        folder: "gappo_chat_app",
        allowed_formats: ["jpg", "png", "jpeg"],
        resource_type: "auto",
      });

      uploadedUrl = uploaded.secure_url;
    }

    const newGroup = await Group.create({
      groupName,
      groupProfilePic: uploadedUrl,
      groupMember,
      admins,
      superAdmin,
    });

    // Emit to all group members (including admin/superAdmin)
    const allMembers = [...new Set([...groupMember, ...admins, superAdmin])];
    allMembers.forEach((userId) => {
      req.io.to(userId.toString()).emit("newGroupCreated", {
        _id: newGroup._id,
        groupName: newGroup.groupName,
        groupProfilePic: newGroup.groupProfilePic,
        groupMember: newGroup.groupMember,
        admins: newGroup.admins,
        superAdmin: newGroup.superAdmin,
      });
    });

    res.status(200).json({
      message: "Group Created",
      groupId: newGroup._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const GetAllGroups = async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId)
      return res.status(400).json({ message: "User ID is required." });

    const allGroups = await Group.find({
      groupMember: userId,
    })
      .populate("groupMember", "groupProfilePic groupName")
      .populate("admins", "groupProfilePic groupName")
      .populate("superAdmin", "groupProfilePic groupName");

    return res.status(200).json(allGroups);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// send message

const SendGroupMessageToDb = async (req, res) => {
  console.log("reqbody", req.body);
  const { groupId, senderId, content, media = [] } = req.body;
  try {
    console.log("groupIdbysendgroupMessage", groupId);
    let mediaUrls = [];

    for (const base64Data of media) {
      const uploaded = await cloudinary.uploader.upload(base64Data, {
        folder: "gappo_chat_app",
        resource_type: "auto",
      });
      mediaUrls.push(uploaded.secure_url);
    }

    const newMessage = new GroupMessage({
      groupId,
      sender: senderId,
      content,
      media: mediaUrls,
      seenBy: [senderId],
    });

    const saveMessage = await newMessage.save();
    console.log("groupsaveMessage", saveMessage);
    // const populateMessage = await saveMessage
    //   .populate("sender", "_id groupProfilePic groupName")
    //   .populate("senderId", "_id username profilePic")
    const populateMessage = await GroupMessage.findById(saveMessage._id)
      .populate("sender", "_id username profilePic")
      .populate("seenBy", "_id username profilePic");
    console.log("grouppopMessage", populateMessage);

    req.io.to(groupId).emit("newGroupMessage", populateMessage);

    return res.status(200).json(populateMessage);
  } catch (err) {
    console.error("Error sending group message:", err.message);
    return res.status(500).json({
      message: "Error Sending group message.",
    });
  }
};

const GetGroupMessages = async (req, res) => {
  try {
    const message = await GroupMessage.find({
      groupId: req.params.groupId,
    }).populate("sender", "_id groupProfilePic groupName");
    console.log("group message", message);
    return res.status(200).json(message);
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching group message.",
    });
  }
};

module.exports = {
  CreateGroup,
  GetAllGroups,
  SendGroupMessageToDb,
  GetGroupMessages,
};
