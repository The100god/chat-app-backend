// backend/utils/socketManager.js
const {
  handleFriendRequestSocket,
} = require("../controllers/friendController");
const User = require("../models/User");
const Message = require("../models/Message");
const Chat = require("../models/Chat");
// const { sendMessages } = require("../controllers/messageController");
const { SendGroupMessageToDb } = require("../controllers/groupController");
const Group = require("../models/Group");
const GroupMessage = require("../models/GroupMessage");
const users = new Map(); // userId -> socket.id
const groups = new Map(); // groupId -> { members, admins, chatName }

const initializeSocket = (io) => {
  io.on("connection", (socket) => {
    // console.log("🟢 New user connected:", socket.id);

    socket.on("join", (userId) => {
      socket.join(userId);
      // console.log("userId", userId);
      // console.log("Id", socket.id);
      users.set(userId, socket.id);
      // console.log(`✅ User ${userId} joined with socket ID: ${socket.id}`);
    });

    // socket.on("markMessagesAsRead", async ({ chatId, userId, friendId }) => {
    //   try {
    //     await Message.updateMany(
    //       { chatId, receiver: userId, sender: friendId, isRead: false },
    //       { $set: { isRead: true } }
    //     );

    //     // Count remaining unread from the same sender (should be 0)
    //     const unreadCount = await Message.countDocuments({
    //       sender: friendId,
    //       receiver: userId,
    //       isRead: false,
    //     });

    //     const receiverSocket = users.get(userId);
    //     if (receiverSocket) {
    //       io.to(receiverSocket).emit("unreadMessageCountUpdated", {
    //         friendId,
    //         count: unreadCount,
    //       });
    //     }
    //   } catch (err) {
    //     console.error("❌ Error in markMessagesAsRead:", err.message);
    //   }
    // });

    socket.on("getFriendListWithUnseen", async ({ userId }) => {
      try {
        const receiver = await User.findById(userId).populate(
          "friends",
          "username profilePic"
        );
        if (!receiver) return;

        const friendDetails = await Promise.all(
          receiver.friends.map(async (friend) => {
            const unreadMessagesCount = await Message.countDocuments({
              sender: friend._id,
              receiver: userId,
              isRead: false,
              $or: [
                { expiresAt: null },
                { expiresAt: { $exists: false } },
                { expiresAt: { $gt: new Date() } },
              ],
            });
            return {
              friendId: friend._id,
              username: friend.username,
              profilePic: friend.profilePic,
              unreadMessagesCount,
            };
          })
        );

        socket.emit("friendsUpdated", friendDetails);
      } catch (error) {
        console.error("❌ Error in getFriendListWithUnseen:", error.message);
        socket.emit("friendsUpdated", []);
      }
    });

    socket.on(
      "handleFriendRequest",
      async ({ senderId, receiverId, status }) => {
        try {
          await handleFriendRequestSocket({
            senderId,
            receiverId,
            status,
            io,
            users,
          });

          const senderSocket = users.get(senderId);
          const receiverSocket = users.get(receiverId);
          if (senderSocket) {
            if (status === "accepted") {
              io.to(senderSocket).emit("friendRequestAccepted", { receiverId });
              // console.log(`🤝 Friend request accepted by ${receiverId}`);
            } else {
              io.to(senderSocket).emit("friendRequestDenied", { receiverId });
              console.error(`🚫 Friend request denied by ${receiverId}`);
            }
          }

          // Notify receiver (updated friend list)
          if (receiverSocket && status === "accepted") {
            const receiver = await User.findById(receiverId).populate(
              "friends",
              "username profilePic"
            );
            const friendDetails = await Promise.all(
              receiver.friends.map(async (friend) => {
                const unreadMessagesCount = await Message.countDocuments({
                  sender: friend._id,
                  receiver: receiverId,
                  isRead: false,
                  $or: [
                    { expiresAt: null },
                    { expiresAt: { $exists: false } },
                    { expiresAt: { $gt: new Date() } },
                  ],
                });
                return {
                  friendId: friend._id,
                  username: friend.username,
                  profilePic: friend.profilePic,
                  unreadMessagesCount,
                };
              })
            );

            io.to(receiverSocket).emit("friendsUpdated", friendDetails);
          }
        } catch (err) {
          console.error("Error handling friend request:", err.message);
          socket.emit("error", { message: err.message });
        }
      }
    );
    socket.on("typing", ({ receiverId, userId }) => {
      io.to(receiverId).emit("typing", userId);
    });
    socket.on("stopTyping", ({ receiverId, userId }) => {
      io.to(receiverId).emit("stopTyping", userId);
    });

    socket.on("messagesRead", async ({ chatId, readerId, senderId }) => {
      // Step 1: Find unread messages that have a disappearDuration set
      const unreadMessages = await Message.find({
        chatId: chatId,
        sender: senderId,
        receiver: readerId,
        isRead: false,
      });

      // Step 2: Mark all as read, and set expiresAt for messages with a disappearDuration
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

      if (bulkOps.length > 0) {
        await Message.bulkWrite(bulkOps);
      }

      // Step 3: Fetch updated messages to emit with expiresAt included
      const updatedMessages = await Message.find({ chatId })
        .populate("sender", "_id username profilePic");

      io.to(chatId).emit("messagesReadAck", {
        chatId,
        readerId,
        updatedMessages,
      });

      if (readerId) {
        io.to(readerId.toString()).emit("update_unseen_count", {
          friendId: senderId,
          count: 0,
        });
        io.to(readerId.toString()).emit("unreadMessageCountUpdated", {
          friendId: senderId,
          count: 0,
        });
      }
    });

    socket.on(
      "sendMessage",
      async ({ chatId, senderId, content, receiverId }) => {
        try {
          const targetReceiverId = receiverId || (typeof receiverId === 'object' ? receiverId._id : null);
          if (!targetReceiverId || !senderId) return;

          const unreadCount = await Message.countDocuments({
            sender: senderId,
            receiver: targetReceiverId,
            isRead: false,
            $or: [
              { expiresAt: null },
              { expiresAt: { $exists: false } },
              { expiresAt: { $gt: new Date() } },
            ],
          });

          io.to(targetReceiverId.toString()).emit("unreadMessageCountUpdated", {
            friendId: senderId,
            count: unreadCount,
          });
          io.to(targetReceiverId.toString()).emit("update_unseen_count", {
            friendId: senderId,
            count: unreadCount,
          });
        } catch (error) {
          console.error("Error sending message:", error);
        }
      }
    );

    // read unseen message — also set expiresAt for disappearing messages
    socket.on("mark_messages_read", async ({ senderId, receiverId }) => {
      if (!senderId || !receiverId) return;

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

      if (bulkOps.length > 0) {
        await Message.bulkWrite(bulkOps);
      }

      io.to(receiverId.toString()).emit("unreadMessageCountUpdated", {
        friendId: senderId,
        count: 0,
      });
      io.to(receiverId.toString()).emit("update_unseen_count", {
        friendId: senderId,
        count: 0,
      });
    });

    socket.on("sendFriendRequest", async ({ senderId, receiverId }) => {
      try {
        const receiver = await User.findById(receiverId);
        const sender = await User.findById(senderId);

        if (!receiver || !sender) return;

        // Avoid duplicate requests
        if (receiver.friendRequests.includes(senderId)) return;

        // Add the senderId to the receiver's friendRequests list
        receiver.friendRequests.push(senderId);
        await receiver.save();

        // Send real-time notification to the receiver (if online)
        const receiverSocketId = users.get(receiverId); // Assuming you maintain a map of online users
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("friendRequestReceived", {
            senderId: sender._id,
            username: sender.username,
            profilePic: sender.profilePic,
          });
        }

        // Confirm to sender that request was sent
        const senderSocketId = users.get(senderId);
        if (senderSocketId) {
          io.to(senderSocketId).emit("friendRequestSent", {
            receiverId,
          });
        }
      } catch (error) {
        console.error("Error sending friend request:", error);
      }
    });

    // Get list of user IDs that the current user has sent friend requests to
    socket.on("getSentFriendRequests", async ({ userId }) => {
      try {
        // Find all users who have this userId in their friendRequests array
        const usersWithPendingRequests = await User.find(
          { friendRequests: userId },
          { _id: 1 }
        );
        const sentIds = usersWithPendingRequests.map((u) => u._id.toString());
        socket.emit("sentFriendRequestsList", sentIds);
      } catch (error) {
        console.error("❌ Error in getSentFriendRequests:", error.message);
        socket.emit("sentFriendRequestsList", []);
      }
    });

    socket.on("getFriendRequests", async ({ userId }) => {
      try {
        const user = await User.findById(userId).populate(
          "friendRequests",
          "_id username profilePic email"
        );
        if (!user) {
          return socket.emit("friendRequestsList", []);
        }
        const friendRequests = user.friendRequests.map((requester) => ({
          _id: requester._id,
          username: requester.username,
          profilePic: requester.profilePic,
        }));

        socket.emit("friendRequestsList", friendRequests);
      } catch (error) {
        console.error("❌ Error in getFriendRequests:", error.message);
        socket.emit("friendRequestsList", []);
      }
    });

    // Get detailed sent friend requests (with username + profilePic)
    socket.on("getSentFriendRequestsDetailed", async ({ userId }) => {
      try {
        const usersWithPendingRequests = await User.find(
          { friendRequests: userId },
          { _id: 1, username: 1, profilePic: 1 }
        );
        socket.emit("sentFriendRequestsDetailedList", usersWithPendingRequests);
      } catch (error) {
        console.error("❌ Error in getSentFriendRequestsDetailed:", error.message);
        socket.emit("sentFriendRequestsDetailedList", []);
      }
    });

    // Cancel a sent friend request
    socket.on("cancelFriendRequest", async ({ senderId, receiverId }) => {
      try {
        const receiver = await User.findById(receiverId);
        if (!receiver) return;

        receiver.friendRequests = receiver.friendRequests.filter(
          (id) => id.toString() !== senderId
        );
        await receiver.save();

        // Notify sender
        const senderSocketId = users.get(senderId);
        if (senderSocketId) {
          io.to(senderSocketId).emit("friendRequestCancelled", { receiverId });
        }

        // Notify receiver to remove from their incoming list
        const receiverSocketId = users.get(receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("friendRequestRemoved", { senderId });
        }
      } catch (error) {
        console.error("❌ Error cancelling friend request:", error.message);
      }
    });

    //Join Group room

    socket.on("joinGroup", (groupId) => {
      socket.join(groupId);
      // console.log(`Joined group ${groupId}`);
    });

    //create a new group
    socket.on(
      "createGroup",
      ({ groupId, adminId, members, groupName, superAdmin }) => {
        groups.set(groupId, {
          members: new Set(members),
          admins: new Set(adminId),
          groupName: groupName,
          superAdmin: superAdmin,
        });

        // io.emit("newGroupCreated", {
        //   _id: groupId,
        //   groupName,
        //   groupProfilePic: "https://some-url.com/pic.jpg", // optional if you save it
        //   groupMember: members,
        //   admins: adminId,
        //   superAdmin,
        // });
        // console.log("groups", groups);
        // console.log(`👥 Group ${groupName} created by ${adminId}`);
      }
    );

    // socket.on("sendGroupMessage", async ({ groupId, senderId, content, media }) => {
    //   const group = groups.get(groupId);
    //   if (group && group.members.has(senderId)) {
    //     const saveMessage = await SendGroupMessage({
    //       groupId,
    //       senderId,
    //       content,
    //       media,
    //     })
    //     // group.members.forEach((memberId) => {
    //     //   const memberSocket = users.get(memberId);
    //     //   if (memberSocket) {
    //     //     io.to(memberSocket).emit("receiverGroupMessage", saveMessage);
    //     //   }
    //     // });
    //     socket.to(groupId).emit("receiverGroupMessage", saveMessage); // others
    // socket.emit("receiverGroupMessage", saveMessage); // sender
    //     console.log(`📢 Group message sent to group ${groupId}`);
    //   } else {
    //     console.log(`❌ Sender not part of group ${groupId}`);
    //   }
    // });
    socket.on(
      "sendGroupMessage",
      async ({ groupId, senderId, content, media }) => {
        let group = groups.get(groupId);

        // Extra check if sender is not found
        if (!group || !group.members.has(senderId)) {
          const dbGroup = await Group.findById(groupId);
          if (!dbGroup || !dbGroup.groupMember.map(String).includes(senderId)) {
            // return console.log(`❌ Sender not part of group ${groupId}`);
            return socket.emit("error", {
              message: `Sender not part of group ${groupId}`,
            });
          }

          // Sync memory state
          groups.set(groupId, {
            members: new Set(dbGroup.groupMember.map(String)),
            admins: new Set(dbGroup.admins.map(String)),
            groupName: dbGroup.groupName,
            superAdmin: String(dbGroup.superAdmin),
          });

          group = groups.get(groupId); // reassign
        }
        // console.log("groupId", groupId);

        // const saveMessage = await SendGroupMessageToDb({
        //   groupId:groupId,
        //   senderId:senderId,
        //   content:content,
        //   media:media
        //  });
        // console.log("socketGroupSaveMessage", saveMessage)
        // socket.to(groupId).emit("receiverGroupMessage", saveMessage);
        // socket.emit("receiverGroupMessage", saveMessage);
        console.log(`📢 Group message sent to group ${groupId}`);
      }
    );

    socket.on("groupMessagesRead", async ({ groupId, readerId }) => {
      await GroupMessage.updateMany({
        groupId,
        seenBy: {
          $ne: readerId,
        },
      },
      {$addToSet:{seenBy:readerId

      }}

    );

    const updatedMessages = await GroupMessage.find({ groupId })
    .populate("sender", "_id username profilePic")
    .populate("seenBy", "_id username profilePic");

    // console.log("updatedMessages", updatedMessages)
    io.to(groupId).emit("groupSeenUpdate", {
      groupId, messages: updatedMessages 
    })
    });

    socket.on("addToGroup", ({ groupId, adminId, newMemberId }) => {
      const group = groups.get(groupId);
      if (group && group.admins.has(adminId)) {
        group.members.add(newMemberId);

        // console.log(`✅ Member ${newMemberId} added to group ${groupId}`);
      } else {
        console.error(`❌ Unauthorized action by ${adminId}`);
      }
    });

    socket.on("removeFromGroup", ({ groupId, adminId, memberId }) => {
      const group = groups.get(groupId);
      if (group && group.superAdmin === adminId) {
        group.members.delete(memberId);
        // console.log(`🚪 Member ${memberId} removed from group ${groupId}`);
      } else {
        console.error(`❌ Unauthorized action by ${adminId}`);
      }
    });

    socket.on("grantAdmin", ({ groupId, adminId, newAdminId }) => {
      const group = groups.get(groupId);
      if (group && group.superAdmin === adminId) {
        group.admins.add(newAdminId);
        // console.log(`👑 Admin privileges granted to ${newAdminId}`);
      } else {
        console.error(`❌ Unauthorized action by ${adminId}`);
      }
    });

    socket.on("disconnect", () => {
      for (let [key, value] of users.entries()) {
        if (value === socket.id) {
          // console.log(`❌ User ${key} disconnected.`);
          users.delete(key);
          break;
        }
      }
    });
  });
};

module.exports = { initializeSocket };
