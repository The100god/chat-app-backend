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
const { sendPushNotification } = require("./webPushHelper");
const {
  getSocketUserId,
  validateFriendship,
  createRoom,
  joinRoom,
  leaveRoom,
  closeRoom,
  switchGame,
  updateRoomState,
  getRoom,
  getRoomForUser,
  getRejoinableRoomsForUser,
  handleDisconnect: handleTogetherDisconnect,
  makeTicTacToeMove,
  restartTicTacToeGame,
  startTicTacToeGame,
  addTicTacToeComment,
  swapTicTacToeFirstPlayer,
  submitRPSChoice,
  nextRPSRound,
  restartRPSGame,
  makeConnect4Move,
  startConnect4Game,
  swapConnect4FirstPlayer,
  restartConnect4Game,
  flipMemoryCard,
  resetMemoryFlippedCards,
  swapMemoryFirstPlayer,
  startMemoryGame,
  restartMemoryGame,
  addDrawingElement,
  clearDrawingBoard,
  switchDrawingMode,
  submitSecretDrawing,
  resetSecretMindMatch,
  submitMindMatchChoice,
  resetMindMatch,
  submitQuizAnswer,
  swapQuizFirstPlayer,
  startQuizGame,
  submitCustomQuizQuestion,
  restartQuizGame,
  submitActivityAnswer,
  nextActivityPrompt,
  selectTruthOrDare,
  submitTruthOrDareQuestion,
  submitTruthOrDareAnswer,
  switchActivityCategory,
  switchActivity,
  updateWatchState,
  updateMusicState,
} = require("./togetherRoomManager");
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
              deletedFor: { $ne: userId },
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
                  deletedFor: { $ne: receiverId },
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
            deletedFor: { $ne: targetReceiverId },
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

        // Trigger background push notification for friend request
        sendPushNotification(receiverId, {
          title: "Chugli",
          body: "New friend request received!",
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          data: {
            type: "friend_request",
            senderId: senderId,
          },
        }).catch((err) => console.error("Error in friend request push sending:", err));

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
        {
          $addToSet: {
            seenBy: readerId

          }
        }

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

    // ═══════════════════════════════════════════════════
    // Together Room Events
    // ═══════════════════════════════════════════════════

    socket.on("together:create", async ({ type, gameId, targetUserId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = createRoom(userId, type, gameId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${result.room.roomId}`;
      socket.join(roomSocketId);
      socket.emit("together:created", result.room);
      io.to(roomSocketId).emit("together:state", result.room);

      // If a target user was selected to invite
      if (targetUserId) {
        try {
          const isFriend = await validateFriendship(userId, targetUserId);
          if (isFriend) {
            const hostUser = await User.findById(userId).select("username profilePic");

            io.to(targetUserId.toString()).emit("together:inviteReceived", {
              roomId: result.room.roomId,
              roomType: type,
              gameId: gameId || "tictactoe",
              hostId: userId.toString(),
              hostUsername: hostUser?.username || "Friend",
              hostProfilePic: hostUser?.profilePic,
            });

            sendPushNotification(targetUserId, {
              title: "Chugli Together Invite",
              body: `${hostUser?.username || "A friend"} invited you to join a ${type} session!`,
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              data: {
                type: "together_invite",
                roomId: result.room.roomId,
                roomType: type,
                gameId: gameId || "tictactoe",
                hostId: userId,
              },
            }).catch((err) => console.error("Error sending together invite push:", err));
          }
        } catch (err) {
          console.error("Error sending room invitation:", err);
        }
      }
    });

    socket.on("together:join", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      // Validate room exists
      const existingRoom = getRoom(roomId);
      if (!existingRoom) return socket.emit("together:error", { message: "Room not found" });

      // Validate friendship with host
      const isFriend = await validateFriendship(userId, existingRoom.hostId);
      if (!isFriend && userId !== existingRoom.hostId) {
        return socket.emit("together:error", { message: "You must be friends with the host to join" });
      }

      const result = joinRoom(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      socket.join(roomSocketId);
      io.to(roomSocketId).emit("together:joined", { userId, room: result.room });
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:leave", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = leaveRoom(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      socket.leave(roomSocketId);

      if (result.closed) {
        // Room was closed (host left) — notify all remaining participants
        io.to(roomSocketId).emit("together:closed", { roomId, reason: "host_left" });
        io.emit("together:roomClosed", { roomId });
        // Force all sockets to leave the room channel
        io.in(roomSocketId).socketsLeave(roomSocketId);
      } else {
        io.to(roomSocketId).emit("together:left", { userId, room: result.room });
        io.to(roomSocketId).emit("together:state", result.room);
      }

      socket.emit("together:state", null);
    });

    socket.on("together:close", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = closeRoom(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:closed", { roomId, reason: "host_closed" });
      io.emit("together:roomClosed", { roomId });
      // Force all sockets to leave the room channel
      io.in(roomSocketId).socketsLeave(roomSocketId);
    });

    socket.on("together:switchGame", async ({ roomId, gameId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = switchGame(roomId, userId, gameId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:update", async ({ roomId, patch }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      if (!patch || typeof patch !== "object") {
        return socket.emit("together:error", { message: "Invalid state patch" });
      }

      const result = updateRoomState(roomId, userId, patch);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:tictactoe:move", async ({ roomId, cellIndex }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = makeTicTacToeMove(roomId, userId, cellIndex);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:tictactoe:restart", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = restartTicTacToeGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:tictactoe:comment", async ({ roomId, text }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = addTicTacToeComment(roomId, userId, text);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:tictactoe:swapFirstTurn", async ({ roomId, firstPlayerId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = swapTicTacToeFirstPlayer(roomId, userId, firstPlayerId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:tictactoe:startGame", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = startTicTacToeGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    // ─── Rock Paper Scissors Listeners ───
    socket.on("together:rps:choice", async ({ roomId, choice }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitRPSChoice(roomId, userId, choice);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:rps:nextRound", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = nextRPSRound(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:rps:restart", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = restartRPSGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    // ─── Connect 4 Listeners ───
    socket.on("together:connect4:dropToken", async ({ roomId, colIndex }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = makeConnect4Move(roomId, userId, colIndex);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:connect4:startGame", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = startConnect4Game(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:connect4:swapFirstTurn", async ({ roomId, firstPlayerId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = swapConnect4FirstPlayer(roomId, userId, firstPlayerId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:connect4:restart", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = restartConnect4Game(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    // ─── Memory Match Listeners ───
    socket.on("together:memory:flipCard", async ({ roomId, cardIndex }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = flipMemoryCard(roomId, userId, cardIndex);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:memory:resetFlipped", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = resetMemoryFlippedCards(roomId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:memory:swapFirstTurn", async ({ roomId, firstPlayerId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = swapMemoryFirstPlayer(roomId, userId, firstPlayerId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:memory:startGame", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = startMemoryGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:memory:restart", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = restartMemoryGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    // ─── Drawing Board Listeners ───
    socket.on("together:drawing:addElement", async ({ roomId, element }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = addDrawingElement(roomId, userId, element);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:drawing:clear", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = clearDrawingBoard(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:drawing:switchMode", async ({ roomId, mode }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = switchDrawingMode(roomId, userId, mode);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:drawing:submitSecret", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitSecretDrawing(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:drawing:resetSecret", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = resetSecretMindMatch(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:drawing:resetMindMatch", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = resetMindMatch(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    // ─── Trivia Quiz Listeners ───
    socket.on("together:quiz:swapFirstTurn", async ({ roomId, firstPlayerId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = swapQuizFirstPlayer(roomId, userId, firstPlayerId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:quiz:startGame", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = startQuizGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:quiz:submitCustomQuestion", async ({ roomId, questionText, audioData, options, correctIndex }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitCustomQuizQuestion(roomId, userId, { questionText, audioData, options, correctIndex });
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:quiz:submitAnswer", async ({ roomId, questionIndex, optionIndex }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitQuizAnswer(roomId, userId, questionIndex, optionIndex);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:quiz:restart", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = restartQuizGame(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    // ─── Couple Activities Listeners ───
    socket.on("together:activity:submitAnswer", async ({ roomId, answer }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitActivityAnswer(roomId, userId, answer);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:activity:nextPrompt", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = nextActivityPrompt(roomId, userId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:activity:selectTruthOrDare", async ({ roomId, choice }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = selectTruthOrDare(roomId, userId, choice);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:activity:submitTruthOrDareQuestion", async ({ roomId, customText, audioData }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitTruthOrDareQuestion(roomId, userId, customText, audioData);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:activity:submitTruthOrDareAnswer", async ({ roomId, answerText, audioData }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = submitTruthOrDareAnswer(roomId, userId, answerText, audioData);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:activity:switchCategory", async ({ roomId, category }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = switchActivityCategory(roomId, userId, category);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:activity:switchActivity", async ({ roomId, newActivityId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = switchActivity(roomId, userId, newActivityId);
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:watch:updateState", async ({ roomId, action, position, mediaUrl, mediaTitle, text, username }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = updateWatchState(roomId, userId, { action, position, mediaUrl, mediaTitle, text, username });
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:music:updateState", async ({ roomId, action, position, trackIndex, track, text, username }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      const result = updateMusicState(roomId, userId, { action, position, trackIndex, track, text, username });
      if (result.error) return socket.emit("together:error", { message: result.error });

      const roomSocketId = `together:${roomId}`;
      io.to(roomSocketId).emit("together:state", result.room);
    });

    socket.on("together:getState", async ({ roomId }) => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return socket.emit("together:error", { message: "Not authenticated" });

      // If roomId provided, get that room; otherwise get user's current room
      let room;
      if (roomId) {
        room = getRoom(roomId);
        if (room && !room.participants.includes(userId)) {
          return socket.emit("together:error", { message: "You are not in this room" });
        }
      } else {
        room = getRoomForUser(userId);
      }

      socket.emit("together:state", room || null);

      // If user is in a room, make sure they're in the socket room channel (reconnect case)
      if (room) {
        socket.join(`together:${room.roomId}`);
      }
    });

    socket.on("together:getRejoinableRooms", async () => {
      const userId = getSocketUserId(socket, users);
      if (!userId) return;

      const rejoinableRooms = await getRejoinableRoomsForUser(userId);
      socket.emit("together:rejoinableRooms", rejoinableRooms);
    });

    // ═══════════════════════════════════════════════════
    // Disconnect
    // ═══════════════════════════════════════════════════

    socket.on("disconnect", () => {
      let disconnectedUserId = null;
      for (let [key, value] of users.entries()) {
        if (value === socket.id) {
          disconnectedUserId = key;
          users.delete(key);
          break;
        }
      }

      // Auto-leave Together room on disconnect
      if (disconnectedUserId) {
        const result = handleTogetherDisconnect(disconnectedUserId);
        if (result && result.roomId) {
          const roomSocketId = `together:${result.roomId}`;
          if (result.closed) {
            io.to(roomSocketId).emit("together:closed", { roomId: result.roomId, reason: "host_disconnected" });
            io.in(roomSocketId).socketsLeave(roomSocketId);
          } else if (result.room) {
            io.to(roomSocketId).emit("together:left", { userId: disconnectedUserId, room: result.room });
            io.to(roomSocketId).emit("together:state", result.room);
          }
        }
      }
    });
  });
};

module.exports = { initializeSocket };
