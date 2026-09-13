const mongoose = require("mongoose");
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

    const uObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;

    const allGroups = await Group.find({
      $or: [
        { groupMember: uObjectId },
        { groupMember: userId },
        { admins: uObjectId },
        { admins: userId },
        { superAdmin: uObjectId },
        { superAdmin: userId },
      ],
    })
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email")
      .lean();

    const groupsWithUnread = await Promise.all(
      allGroups.map(async (group) => {
        const unreadCount = await GroupMessage.countDocuments({
          groupId: group._id,
          seenBy: { $nin: [uObjectId, userId] },
          deletedFor: { $nin: [uObjectId, userId] },
          $or: [
            { expiresAt: null },
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: new Date() } },
          ],
        });
        return {
          ...group,
          unreadCount,
        };
      })
    );

    return res.status(200).json(groupsWithUnread);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// send message

const { sendPushNotification } = require("../utils/webPushHelper");

const SendGroupMessageToDb = async (req, res) => {
  // console.log("reqbody", req.body);
  const { groupId, senderId, content, media = [] } = req.body;
  try {
    // console.log("groupIdbysendgroupMessage", groupId);
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
    const populateMessage = await GroupMessage.findById(saveMessage._id)
      .populate("sender", "_id username profilePic")
      .populate("seenBy", "_id username profilePic");

    // Fetch the group to find all member IDs (including admins & superAdmin)
    const group = await Group.findById(groupId);
    const targetRooms = [groupId.toString()];
    const allMemberIds = new Set();
    if (group) {
      if (Array.isArray(group.groupMember)) {
        group.groupMember.forEach((mId) => allMemberIds.add(mId.toString()));
      }
      if (Array.isArray(group.admins)) {
        group.admins.forEach((mId) => allMemberIds.add(mId.toString()));
      }
      if (group.superAdmin) {
        allMemberIds.add(group.superAdmin.toString());
      }
    }
    allMemberIds.forEach((mId) => targetRooms.push(mId));

    // Broadcast new group message to group room AND all member personal rooms
    if (req.io) {
      const messagePayload = {
        ...populateMessage.toObject(),
        groupName: group?.groupName || "Group",
        groupProfilePic: group?.groupProfilePic || null,
        groupId: groupId.toString(),
      };
      req.io.to(targetRooms).emit("newGroupMessage", messagePayload);
      req.io.to(targetRooms).emit("groupMessageNotification", {
        message: messagePayload,
        groupId: groupId.toString(),
        groupName: group?.groupName || "Group",
        sender: populateMessage.sender,
      });

      // Compute and emit updated unreadCount for each other member
      const senderIdStr = String(senderId);
      const otherMembers = Array.from(allMemberIds).filter(
        (mId) => mId !== senderIdStr
      );

      for (const memberId of otherMembers) {
        try {
          const mObjectId = mongoose.Types.ObjectId.isValid(memberId)
            ? new mongoose.Types.ObjectId(memberId)
            : memberId;

          const count = await GroupMessage.countDocuments({
            groupId,
            seenBy: { $nin: [mObjectId, memberId] },
            deletedFor: { $nin: [mObjectId, memberId] },
            $or: [
              { expiresAt: null },
              { expiresAt: { $exists: false } },
              { expiresAt: { $gt: new Date() } },
            ],
          });
          req.io.to(memberId).emit("groupUnreadCountUpdated", {
            groupId: groupId.toString(),
            count,
          });
        } catch (err) {
          console.error("Error updating unread count for member:", err);
        }
      }
    }

    // Group Push Notification Trigger
    try {
      if (group) {
        const senderIdStr = String(senderId);
        const otherMembers = Array.from(allMemberIds).filter(
          (mId) => mId !== senderIdStr
        );

        otherMembers.forEach((memberId) => {
          sendPushNotification(memberId, {
            title: "Chugli",
            body: "New message received!",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            data: {
              groupId: groupId,
            },
          }).catch((err) => console.error("Error in group push sending:", err));
        });
      }
    } catch (pushErr) {
      console.error("Failed to query group or send group push notifications:", pushErr);
    }

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
    const { userId } = req.query;
    const query = {
      groupId: req.params.groupId,
      $or: [
        { expiresAt: null },
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    };

    if (userId) {
      query.deletedFor = { $ne: userId };
    }

    const message = await GroupMessage.find(query)
      .populate("sender", "_id username profilePic groupProfilePic groupName")
      .populate("seenBy", "_id username profilePic");
    return res.status(200).json(message);
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching group message.",
    });
  }
};

const GetGroupDetails = async (req, res) => {
  try {
    const { groupId } = req.params;
    const group = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    if (!group) {
      return res.status(404).json({ message: "Group not found." });
    }
    return res.status(200).json(group);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const UpdateGroupInfo = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { groupName, groupProfilePic, description, requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    const isAdmin = group.admins.map(String).includes(requesterId) || String(group.superAdmin) === requesterId;
    if (!isAdmin) {
      return res.status(403).json({ message: "Only admins can edit group info." });
    }

    if (groupName) group.groupName = groupName;
    if (description !== undefined) group.description = description;

    if (groupProfilePic && groupProfilePic.startsWith("data:image")) {
      const uploaded = await cloudinary.uploader.upload(groupProfilePic, {
        folder: "gappo_chat_app",
        allowed_formats: ["jpg", "png", "jpeg"],
        resource_type: "auto",
      });
      group.groupProfilePic = uploaded.secure_url;
    }

    await group.save();

    const updatedGroup = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    req.io.to(groupId).emit("groupUpdated", updatedGroup);

    return res.status(200).json({ message: "Group info updated successfully.", group: updatedGroup });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const AddGroupMembers = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { userIds, requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    const isAdmin = group.admins.map(String).includes(requesterId) || String(group.superAdmin) === requesterId;
    if (!isAdmin) {
      return res.status(403).json({ message: "Only admins can add members." });
    }

    userIds.forEach((id) => {
      if (!group.groupMember.map(String).includes(id)) {
        group.groupMember.push(id);
      }
    });

    await group.save();

    const updatedGroup = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    req.io.to(groupId).emit("groupUpdated", updatedGroup);

    userIds.forEach((userId) => {
      req.io.to(userId.toString()).emit("newGroupCreated", updatedGroup);
    });

    return res.status(200).json({ message: "Members added successfully.", group: updatedGroup });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const RemoveGroupMember = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberId, requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    const isAdmin = group.admins.map(String).includes(requesterId) || String(group.superAdmin) === requesterId;
    if (!isAdmin) {
      return res.status(403).json({ message: "Only admins can remove members." });
    }

    if (String(group.superAdmin) === memberId) {
      return res.status(400).json({ message: "Cannot remove the creator/superAdmin." });
    }

    group.groupMember = group.groupMember.filter((id) => String(id) !== memberId);
    group.admins = group.admins.filter((id) => String(id) !== memberId);

    await group.save();

    const updatedGroup = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    req.io.to(groupId).emit("groupUpdated", updatedGroup);
    req.io.to(memberId).emit("removedFromGroup", { groupId });

    return res.status(200).json({ message: "Member removed successfully.", group: updatedGroup });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const PromoteToAdmin = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberId, requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    const isAdmin = group.admins.map(String).includes(requesterId) || String(group.superAdmin) === requesterId;
    if (!isAdmin) {
      return res.status(403).json({ message: "Only admins can promote members." });
    }

    if (!group.admins.map(String).includes(memberId)) {
      group.admins.push(memberId);
    }

    await group.save();

    const updatedGroup = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    req.io.to(groupId).emit("groupUpdated", updatedGroup);

    return res.status(200).json({ message: "Member promoted to admin successfully.", group: updatedGroup });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const DemoteFromAdmin = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberId, requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    const isAdmin = group.admins.map(String).includes(requesterId) || String(group.superAdmin) === requesterId;
    if (!isAdmin) {
      return res.status(403).json({ message: "Only admins can demote admins." });
    }

    if (String(group.superAdmin) === memberId) {
      return res.status(400).json({ message: "Cannot demote the creator/superAdmin." });
    }

    group.admins = group.admins.filter((id) => String(id) !== memberId);

    await group.save();

    const updatedGroup = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    req.io.to(groupId).emit("groupUpdated", updatedGroup);

    return res.status(200).json({ message: "Admin demoted successfully.", group: updatedGroup });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const LeaveGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    group.groupMember = group.groupMember.filter((id) => String(id) !== requesterId);
    group.admins = group.admins.filter((id) => String(id) !== requesterId);

    if (String(group.superAdmin) === requesterId) {
      if (group.admins.length > 0) {
        group.superAdmin = group.admins[0];
      } else if (group.groupMember.length > 0) {
        group.superAdmin = group.groupMember[0];
        group.admins.push(group.groupMember[0]);
      } else {
        await Group.findByIdAndDelete(groupId);
        await GroupMessage.deleteMany({ groupId });
        req.io.to(groupId).emit("groupDeleted", { groupId });
        req.io.to(requesterId).emit("leftGroup", { groupId });
        return res.status(200).json({ message: "Left group. Group deleted since no members remain." });
      }
    }

    await group.save();

    const updatedGroup = await Group.findById(groupId)
      .populate("groupMember", "username profilePic about email")
      .populate("admins", "username profilePic about email")
      .populate("superAdmin", "username profilePic about email");

    req.io.to(groupId).emit("groupUpdated", updatedGroup);
    req.io.to(requesterId).emit("leftGroup", { groupId });

    return res.status(200).json({ message: "Left group successfully." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const DeleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { requesterId } = req.body;

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: "Group not found." });

    const isAdmin = group.admins.map(String).includes(requesterId) || String(group.superAdmin) === requesterId;
    if (!isAdmin) {
      return res.status(403).json({ message: "Only admins can delete the group." });
    }

    await Group.findByIdAndDelete(groupId);
    await GroupMessage.deleteMany({ groupId });

    req.io.to(groupId).emit("groupDeleted", { groupId });

    return res.status(200).json({ message: "Group deleted successfully." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

module.exports = {
  CreateGroup,
  GetAllGroups,
  SendGroupMessageToDb,
  GetGroupMessages,
  GetGroupDetails,
  UpdateGroupInfo,
  AddGroupMembers,
  RemoveGroupMember,
  PromoteToAdmin,
  DemoteFromAdmin,
  LeaveGroup,
  DeleteGroup,
};
