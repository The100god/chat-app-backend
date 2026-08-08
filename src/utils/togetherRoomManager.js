// backend/utils/togetherRoomManager.js
const crypto = require("crypto");
const User = require("../models/User");
const { cleanupRoomMedia } = require("./cloudinaryHelper");

// ─── In-memory stores ───
const rooms = new Map();     // roomId → TogetherRoom
const userRooms = new Map(); // userId → roomId (1 room per user)

/**
 * Generate a short unique room ID
 */
function generateRoomId() {
  return crypto.randomBytes(6).toString("hex"); // 12-char hex
}

/**
 * Resolve the userId that owns a given socket.id
 * by reverse-looking up the users Map (from socketManager).
 * Returns null if the socket hasn't joined.
 */
function getSocketUserId(socket, usersMap) {
  for (const [userId, socketId] of usersMap.entries()) {
    if (socketId === socket.id) return userId;
  }
  return null;
}

/**
 * Validate that two users are mutual friends.
 * Returns true if userId has targetId in their friends array.
 */
async function validateFriendship(userId, targetId) {
  try {
    const user = await User.findById(userId).select("friends");
    if (!user) return false;
    return user.friends.some((fId) => fId.toString() === targetId.toString());
  } catch {
    return false;
  }
}

// ─── Room CRUD ───

/**
 * Create a new Together room.
 * @param {string} hostId - userId of the creator
 * @param {string} type - "game"|"watch"|"music"|"quiz"|"activity"
 * @returns {{ room: object } | { error: string }}
 */
function createRoom(hostId, type, gameId = null) {
  const validTypes = ["game", "watch", "music", "quiz", "activity"];
  if (!validTypes.includes(type)) {
    return { error: "Invalid room type" };
  }

  // If user is already in a room, automatically clean up old room first
  if (userRooms.has(hostId)) {
    const oldRoomId = userRooms.get(hostId);
    if (oldRoomId && rooms.has(oldRoomId)) {
      leaveRoom(oldRoomId, hostId);
    }
    userRooms.delete(hostId);
  }

  const roomId = generateRoomId();
  const room = {
    roomId,
    type,
    gameId: gameId || null,
    hostId,
    participants: new Set([hostId]),
    state: {},
    sessionStats: {
      [hostId]: { wins: 0, losses: 0, ties: 0, total: 0 },
    },
    createdAt: Date.now(),
  };

  if (type === "game" && gameId) {
    initGameRoomState(room, gameId, hostId);
  } else if (type === "activity") {
    initActivityRoomState(room, gameId || "would_you_rather", hostId);
  } else if (type === "watch") {
    initWatchRoomState(room, hostId);
  } else if (type === "music") {
    initMusicRoomState(room, hostId);
  }

  rooms.set(roomId, room);
  userRooms.set(hostId, roomId);

  return { room: serializeRoom(room) };
}

/**
 * Helper to initialize game states for various game types.
 */
function initGameRoomState(room, gameId, hostId) {
  room.gameId = gameId;
  const pList = Array.from(room.participants || [hostId]);
  const p1 = pList[0] || hostId;
  const p2 = pList[1] || null;

  if (gameId === "tictactoe") {
    room.state.ticTacToe = {
      board: Array(9).fill(null),
      players: { X: p1, O: p2 },
      currentTurn: "X",
      winner: null,
      winningLine: null,
      isDraw: false,
      status: p2 ? "setup" : "waiting",
      comments: [],
    };
  } else if (gameId === "rps") {
    const scores = { [p1]: 0 };
    if (p2) scores[p2] = 0;
    room.state.rps = {
      playerChoices: {},
      scores,
      round: 1,
      status: p2 ? "playing" : "waiting",
      comments: [],
    };
  } else if (gameId === "connect4") {
    room.state.connect4 = {
      board: Array(6).fill(null).map(() => Array(7).fill(null)),
      players: { R: p1, Y: p2 },
      currentTurn: "R",
      winner: null,
      winningLine: null,
      isDraw: false,
      status: p2 ? "setup" : "waiting",
      comments: [],
    };
  } else if (gameId === "memory") {
    const scores = { [p1]: 0 };
    if (p2) scores[p2] = 0;
    room.state.memoryMatch = {
      cards: generateMemoryCards(),
      players: pList,
      scores,
      currentTurn: p1,
      flippedCards: [],
      winner: null,
      isDraw: false,
      status: p2 ? "playing" : "waiting",
      comments: [],
    };
  } else if (gameId === "drawing") {
    room.state.drawing = {
      elements: [],
      status: "active",
      comments: [],
    };
  } else if (gameId === "quiz") {
    const scores = { [p1]: 0 };
    if (p2) scores[p2] = 0;
    room.state.quiz = {
      currentQuestionIndex: 0,
      questions: [],
      answers: {},
      scores,
      status: p2 ? "setup" : "waiting",
      winner: null,
      comments: [],
      askerId: p1,
    };
  }
}

/**
 * Switch game within an existing room session.
 */
function switchGame(roomId, userId, newGameId) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };

  if (!room.participants.has(userId)) {
    return { error: "Unauthorized" };
  }

  room.type = "game";
  initGameRoomState(room, newGameId, room.hostId);

  return { room: serializeRoom(room) };
}

/**
 * Helper to initialize activity room state
 */
function initActivityRoomState(room, activityId = "would_you_rather", hostId) {
  room.activityId = activityId;
  room.state.activity = {
    activityId: activityId || "would_you_rather",
    category: "fun",
    currentPromptIndex: 0,
    answers: {},
    status: "answering",
    turnUserId: hostId,
    truthOrDareChoice: null,
    comments: [],
  };
}

/**
 * Join an existing room.
 * @param {string} roomId
 * @param {string} userId
 * @returns {{ room: object } | { error: string }}
 */
function joinRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) {
    return { error: "Room not found" };
  }

  // Already in this room — idempotent
  if (room.participants.has(userId)) {
    return { room: serializeRoom(room) };
  }

  // If user is already in another room, leave it first
  if (userRooms.has(userId)) {
    const oldRoomId = userRooms.get(userId);
    if (oldRoomId && oldRoomId !== roomId && rooms.has(oldRoomId)) {
      leaveRoom(oldRoomId, userId);
    }
    userRooms.delete(userId);
  }

  room.participants.add(userId);
  userRooms.set(userId, roomId);

  if (!room.sessionStats) room.sessionStats = {};
  if (!room.sessionStats[userId]) {
    room.sessionStats[userId] = { wins: 0, losses: 0, ties: 0, total: 0 };
  }

  if (room.type === "game") {
    if (room.state.ticTacToe) {
      const g = room.state.ticTacToe;
      if (!g.players.O && userId !== g.players.X) g.players.O = userId;
      if (g.players.X && g.players.O && g.status === "waiting") g.status = "setup";
    }
    if (room.state.rps) {
      const g = room.state.rps;
      if (g.scores[userId] === undefined) g.scores[userId] = 0;
      if (room.participants.size >= 2) g.status = "playing";
    }
    if (room.state.connect4) {
      const g = room.state.connect4;
      if (!g.players.Y && userId !== g.players.R) g.players.Y = userId;
      if (g.players.R && g.players.Y && g.status === "waiting") g.status = "setup";
    }
    if (room.state.memoryMatch) {
      const g = room.state.memoryMatch;
      if (!g.players.includes(userId)) g.players.push(userId);
      if (g.scores[userId] === undefined) g.scores[userId] = 0;
      if (g.players.length >= 2 && g.status === "waiting") g.status = "playing";
    }
    if (room.state.quiz) {
      const g = room.state.quiz;
      if (g.scores[userId] === undefined) g.scores[userId] = 0;
      if (room.participants.size >= 2 && g.status === "waiting") {
        g.status = "setup";
      }
    }
  }

  return { room: serializeRoom(room) };
}

/**
 * Leave a room. If the host leaves, the room is closed.
 * @param {string} roomId
 * @param {string} userId
 * @returns {{ room: object|null, closed: boolean } | { error: string }}
 */
function leaveRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) {
    return { error: "Room not found" };
  }

  if (!room.participants.has(userId)) {
    return { error: "You are not in this room" };
  }

  room.participants.delete(userId);
  userRooms.delete(userId);

  // If host leaves, close the room entirely
  if (userId === room.hostId) {
    // Clean up remaining participants
    for (const pid of room.participants) {
      userRooms.delete(pid);
    }
    rooms.delete(roomId);
    cleanupRoomMedia(roomId).catch((err) => console.error("Error cleaning up room media:", err));
    return { room: serializeRoom(room), closed: true };
  }

  // If room is empty, clean it up
  if (room.participants.size === 0) {
    rooms.delete(roomId);
    cleanupRoomMedia(roomId).catch((err) => console.error("Error cleaning up room media:", err));
    return { room: null, closed: true };
  }

  // Reset game comments when a player leaves
  if (room.type === "game" && room.state.ticTacToe) {
    room.state.ticTacToe.comments = [];
    if (userId === room.state.ticTacToe.players.O) {
      room.state.ticTacToe.players.O = null;
      room.state.ticTacToe.status = "waiting";
    }
  }

  return { room: serializeRoom(room), closed: false };
}

/**
 * Close a room (host only).
 * @param {string} roomId
 * @param {string} requesterId
 * @returns {{ participants: string[] } | { error: string }}
 */
function closeRoom(roomId, requesterId) {
  const room = rooms.get(roomId);
  if (!room) {
    return { error: "Room not found" };
  }

  if (room.hostId !== requesterId) {
    return { error: "Only the host can close the room" };
  }

  const participants = Array.from(room.participants);

  // Clean up all participants
  for (const pid of participants) {
    userRooms.delete(pid);
  }
  rooms.delete(roomId);
  cleanupRoomMedia(roomId).catch((err) => console.error("Error cleaning up room media:", err));

  return { participants };
}

/**
 * Update the room's shared state (any participant can update).
 * @param {string} roomId
 * @param {string} userId
 * @param {object} patch - partial state to merge
 * @returns {{ room: object } | { error: string }}
 */
function updateRoomState(roomId, userId, patch) {
  const room = rooms.get(roomId);
  if (!room) {
    return { error: "Room not found" };
  }

  if (!room.participants.has(userId)) {
    return { error: "You are not in this room" };
  }

  // Merge the patch into existing state
  Object.assign(room.state, patch);

  return { room: serializeRoom(room) };
}

/**
 * Get a room by ID (serialized).
 */
function getRoom(roomId) {
  const room = rooms.get(roomId);
  return room ? serializeRoom(room) : null;
}

/**
 * Get the room a user is currently in (serialized).
 */
function getRoomForUser(userId) {
  const roomId = userRooms.get(userId);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  return room ? serializeRoom(room) : null;
}

/**
 * Handle user disconnect — auto-leave any Together room.
 * Returns { roomId, room, closed } if user was in a room, null otherwise.
 */
function handleDisconnect(userId) {
  const roomId = userRooms.get(userId);
  if (!roomId) return null;

  const result = leaveRoom(roomId, userId);
  if (result.error) return null;

  return { roomId, ...result };
}

// ─── Serialization ───

/**
 * Convert a room's Set-based participants to an array for JSON transport.
 */
function serializeRoom(room) {
  return {
    roomId: room.roomId,
    type: room.type,
    gameId: room.gameId,
    hostId: room.hostId,
    participants: Array.from(room.participants),
    state: room.state,
    sessionStats: room.sessionStats || {},
    createdAt: room.createdAt,
  };
}

/**
 * Get all active rooms hosted by friends of userId that are still open for rejoining.
 */
async function getRejoinableRoomsForUser(userId) {
  const result = [];
  try {
    const currentUser = await User.findById(userId).select("friends");
    if (!currentUser || !currentUser.friends) return result;

    const friendIds = new Set(currentUser.friends.map((fId) => fId.toString()));

    for (const [roomId, room] of rooms.entries()) {
      if (room.hostId.toString() !== userId.toString() && friendIds.has(room.hostId.toString())) {
        const hostUser = await User.findById(room.hostId).select("username profilePic");
        result.push({
          roomId: room.roomId,
          roomType: room.type,
          hostId: room.hostId.toString(),
          hostUsername: hostUser?.username || "Friend",
          hostProfilePic: hostUser?.profilePic,
          createdAt: room.createdAt,
        });
      }
    }
  } catch (err) {
    console.error("Error fetching rejoinable rooms:", err);
  }
  return result;
}

const WINNING_COMBINATIONS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

/**
 * Make a Tic-Tac-Toe move (server-authoritative).
 */
function makeTicTacToeMove(roomId, userId, cellIndex) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };
  if (!room.participants.has(userId)) return { error: "You are not in this room" };
  if (room.type !== "game" || !room.state.ticTacToe) return { error: "Not a Tic-Tac-Toe room" };

  const game = room.state.ticTacToe;
  if (game.status !== "playing") return { error: "Game is not in active play state" };

  // Determine player symbol
  let playerSymbol = null;
  if (userId === game.players.X) playerSymbol = "X";
  else if (userId === game.players.O) playerSymbol = "O";
  else return { error: "You are not an active player in this game" };

  // Check turn
  if (game.currentTurn !== playerSymbol) return { error: "Not your turn" };

  // Check valid cell
  if (cellIndex < 0 || cellIndex > 8 || game.board[cellIndex] !== null) {
    return { error: "Invalid move cell" };
  }

  // Execute move
  game.board[cellIndex] = playerSymbol;

  // Check win
  let winner = null;
  let winningLine = null;
  for (const line of WINNING_COMBINATIONS) {
    const [a, b, c] = line;
    if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
      winner = game.board[a];
      winningLine = line;
      break;
    }
  }

  if (winner) {
    game.winner = winner;
    game.winningLine = winningLine;
    game.status = "finished";
    const winnerId = winner === "X" ? game.players.X : game.players.O;
    const loserId = winner === "X" ? game.players.O : game.players.X;
    updateSessionStats(room, winnerId, loserId, false);
  } else if (game.board.every((cell) => cell !== null)) {
    game.isDraw = true;
    game.status = "finished";
    updateSessionStats(room, null, null, true);
  } else {
    game.currentTurn = playerSymbol === "X" ? "O" : "X";
  }

  return { room: serializeRoom(room) };
}

/**
 * Update session statistics for a room.
 */
function updateSessionStats(room, winnerId, loserId, isDraw = false) {
  if (!room.sessionStats) room.sessionStats = {};
  room.participants.forEach((pId) => {
    if (!room.sessionStats[pId]) {
      room.sessionStats[pId] = { wins: 0, losses: 0, ties: 0, total: 0 };
    }
  });

  if (isDraw) {
    room.participants.forEach((pId) => {
      if (room.sessionStats[pId]) {
        room.sessionStats[pId].ties += 1;
        room.sessionStats[pId].total += 1;
      }
    });
  } else {
    if (winnerId && room.sessionStats[winnerId]) {
      room.sessionStats[winnerId].wins += 1;
      room.sessionStats[winnerId].total += 1;
    }
    if (loserId && room.sessionStats[loserId]) {
      room.sessionStats[loserId].losses += 1;
      room.sessionStats[loserId].total += 1;
    }
  }
}

// ─── Rock Paper Scissors ───
function submitRPSChoice(roomId, userId, choice) {
  const room = rooms.get(roomId);
  if (!room || !room.state.rps) return { error: "Room not found" };
  if (!room.participants.has(userId)) return { error: "Not in room" };
  if (!["rock", "paper", "scissors"].includes(choice)) return { error: "Invalid choice" };

  const rps = room.state.rps;
  rps.playerChoices[userId] = choice;

  const pIds = Array.from(room.participants);
  if (pIds.length >= 2 && pIds.every((id) => rps.playerChoices[id])) {
    const [p1, p2] = pIds;
    const c1 = rps.playerChoices[p1];
    const c2 = rps.playerChoices[p2];

    if (c1 === c2) {
      rps.roundResult = { winnerId: null, isDraw: true, reason: `Both picked ${c1}` };
      updateSessionStats(room, null, null, true);
    } else if (
      (c1 === "rock" && c2 === "scissors") ||
      (c1 === "scissors" && c2 === "paper") ||
      (c1 === "paper" && c2 === "rock")
    ) {
      rps.scores[p1] = (rps.scores[p1] || 0) + 1;
      rps.roundResult = { winnerId: p1, isDraw: false, reason: `${c1} beats ${c2}` };
      updateSessionStats(room, p1, p2, false);
    } else {
      rps.scores[p2] = (rps.scores[p2] || 0) + 1;
      rps.roundResult = { winnerId: p2, isDraw: false, reason: `${c2} beats ${c1}` };
      updateSessionStats(room, p2, p1, false);
    }
    rps.status = "round_ended";
  }

  return { room: serializeRoom(room) };
}

function nextRPSRound(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.rps) return { error: "Room not found" };
  const rps = room.state.rps;
  rps.playerChoices = {};
  rps.roundResult = null;
  rps.round += 1;
  rps.status = "playing";
  return { room: serializeRoom(room) };
}

function restartRPSGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.rps) return { error: "Room not found" };
  const rps = room.state.rps;
  rps.playerChoices = {};
  rps.roundResult = null;
  rps.round = 1;
  Array.from(room.participants).forEach((pid) => (rps.scores[pid] = 0));
  rps.status = "playing";
  return { room: serializeRoom(room) };
}

// ─── Connect 4 ───
function makeConnect4Move(roomId, userId, colIndex) {
  const room = rooms.get(roomId);
  if (!room || !room.state.connect4) return { error: "Room not found" };
  const c4 = room.state.connect4;

  if (c4.status !== "playing") return { error: "Game not active" };
  const symbol = userId === c4.players.R ? "R" : userId === c4.players.Y ? "Y" : null;
  if (!symbol || c4.currentTurn !== symbol) return { error: "Not your turn" };
  if (colIndex < 0 || colIndex > 6) return { error: "Invalid column" };

  let targetRow = -1;
  for (let r = 5; r >= 0; r--) {
    if (!c4.board[r][colIndex]) {
      targetRow = r;
      break;
    }
  }

  if (targetRow === -1) return { error: "Column is full" };

  c4.board[targetRow][colIndex] = symbol;

  const winCheck = checkConnect4Win(c4.board, symbol);
  if (winCheck.win) {
    c4.winner = symbol;
    c4.winningLine = winCheck.line;
    c4.status = "finished";
    const winnerId = symbol === "R" ? c4.players.R : c4.players.Y;
    const loserId = symbol === "R" ? c4.players.Y : c4.players.R;
    updateSessionStats(room, winnerId, loserId, false);
  } else if (c4.board.every((row) => row.every((cell) => cell !== null))) {
    c4.isDraw = true;
    c4.status = "finished";
    updateSessionStats(room, null, null, true);
  } else {
    c4.currentTurn = symbol === "R" ? "Y" : "R";
  }

  return { room: serializeRoom(room) };
}

function checkConnect4Win(board, symbol) {
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (board[r][c] !== symbol) continue;

      if (c + 3 < 7 && board[r][c + 1] === symbol && board[r][c + 2] === symbol && board[r][c + 3] === symbol) {
        return { win: true, line: [[r, c], [r, c + 1], [r, c + 2], [r, c + 3]] };
      }
      if (r + 3 < 6 && board[r + 1][c] === symbol && board[r + 2][c] === symbol && board[r + 3][c] === symbol) {
        return { win: true, line: [[r, c], [r + 1, c], [r + 2, c], [r + 3, c]] };
      }
      if (r + 3 < 6 && c + 3 < 7 && board[r + 1][c + 1] === symbol && board[r + 2][c + 2] === symbol && board[r + 3][c + 3] === symbol) {
        return { win: true, line: [[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]] };
      }
      if (r - 3 >= 0 && c + 3 < 7 && board[r - 1][c + 1] === symbol && board[r - 2][c + 2] === symbol && board[r - 3][c + 3] === symbol) {
        return { win: true, line: [[r, c], [r - 1, c + 1], [r - 2, c + 2], [r - 3, c + 3]] };
      }
    }
  }
  return { win: false };
}

function startConnect4Game(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.connect4) return { error: "Room not found" };
  room.state.connect4.status = "playing";
  return { room: serializeRoom(room) };
}

function swapConnect4FirstPlayer(roomId, userId, firstPlayerId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.connect4) return { error: "Room not found" };
  const c4 = room.state.connect4;
  if (firstPlayerId === c4.players.Y) {
    const temp = c4.players.R;
    c4.players.R = c4.players.Y;
    c4.players.Y = temp;
  }
  c4.currentTurn = "R";
  return { room: serializeRoom(room) };
}

function restartConnect4Game(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.connect4) return { error: "Room not found" };
  const c4 = room.state.connect4;
  c4.board = Array(6).fill(null).map(() => Array(7).fill(null));
  c4.winner = null;
  c4.winningLine = null;
  c4.isDraw = false;
  c4.currentTurn = "R";
  c4.status = c4.players.R && c4.players.Y ? "setup" : "waiting";
  return { room: serializeRoom(room) };
}

// ─── Memory Match ───
function generateMemoryCards() {
  const EMOJIS = ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼"];
  const pairs = [...EMOJIS, ...EMOJIS];
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs.map((emoji, id) => ({ id, emoji, isFlipped: false, isMatched: false }));
}

function flipMemoryCard(roomId, userId, cardIndex) {
  const room = rooms.get(roomId);
  if (!room || !room.state.memoryMatch) return { error: "Room not found" };
  const mm = room.state.memoryMatch;

  if (mm.currentTurn !== userId) return { error: "Not your turn" };
  if (mm.flippedCards.length >= 2) return { error: "2 cards already flipped" };

  const card = mm.cards[cardIndex];
  if (!card || card.isFlipped || card.isMatched) return { error: "Invalid card" };

  card.isFlipped = true;
  mm.flippedCards.push(cardIndex);

  if (mm.flippedCards.length === 2) {
    const [idx1, idx2] = mm.flippedCards;
    const card1 = mm.cards[idx1];
    const card2 = mm.cards[idx2];

    if (card1.emoji === card2.emoji) {
      card1.isMatched = true;
      card2.isMatched = true;
      mm.scores[userId] = (mm.scores[userId] || 0) + 1;
      mm.flippedCards = [];

      if (mm.cards.every((c) => c.isMatched)) {
        mm.status = "finished";
        const players = Array.from(room.participants);
        const s1 = mm.scores[players[0]] || 0;
        const s2 = mm.scores[players[1]] || 0;

        if (s1 > s2) {
          mm.winner = players[0];
          updateSessionStats(room, players[0], players[1], false);
        } else if (s2 > s1) {
          mm.winner = players[1];
          updateSessionStats(room, players[1], players[0], false);
        } else {
          mm.isDraw = true;
          updateSessionStats(room, null, null, true);
        }
      }
    } else {
      const nextTurn = mm.players.find((p) => p !== userId) || userId;
      mm.currentTurn = nextTurn;
    }
  }

  return { room: serializeRoom(room) };
}

function resetMemoryFlippedCards(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.memoryMatch) return { error: "Room not found" };
  const mm = room.state.memoryMatch;
  mm.flippedCards.forEach((idx) => {
    if (mm.cards[idx] && !mm.cards[idx].isMatched) {
      mm.cards[idx].isFlipped = false;
    }
  });
  mm.flippedCards = [];
  return { room: serializeRoom(room) };
}

function swapMemoryFirstPlayer(roomId, userId, firstPlayerId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.memoryMatch) return { error: "Room not found" };
  const mm = room.state.memoryMatch;
  mm.currentTurn = firstPlayerId;
  return { room: serializeRoom(room) };
}

function startMemoryGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.memoryMatch) return { error: "Room not found" };
  room.state.memoryMatch.status = "playing";
  return { room: serializeRoom(room) };
}

function restartMemoryGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.memoryMatch) return { error: "Room not found" };
  const mm = room.state.memoryMatch;
  mm.cards = generateMemoryCards();
  mm.flippedCards = [];
  mm.winner = null;
  mm.isDraw = false;
  mm.players = Array.from(room.participants);
  mm.currentTurn = mm.players[0] || userId;
  mm.players.forEach((p) => (mm.scores[p] = 0));
  mm.status = mm.players.length >= 2 ? "setup" : "waiting";
  return { room: serializeRoom(room) };
}

// ─── Drawing Board ───
function switchDrawingMode(roomId, userId, mode) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;
  draw.mode = mode || "live";
  if (mode === "mind_match") {
    draw.secretElements = {};
    draw.secretSubmitted = {};
    draw.secretRevealed = false;
  }
  return { room: serializeRoom(room) };
}

function addDrawingElement(roomId, userId, element) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;

  const newElem = { ...element, userId, id: crypto.randomBytes(4).toString("hex") };

  if (draw.mode === "mind_match") {
    if (!draw.secretElements) draw.secretElements = {};
    if (!Array.isArray(draw.secretElements[userId])) draw.secretElements[userId] = [];
    draw.secretElements[userId].push(newElem);
  } else {
    if (!Array.isArray(draw.elements)) draw.elements = [];
    draw.elements.push(newElem);
  }

  return { room: serializeRoom(room) };
}

function clearDrawingBoard(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;

  if (draw.mode === "mind_match") {
    if (draw.secretElements) draw.secretElements[userId] = [];
  } else {
    draw.elements = [];
  }

  return { room: serializeRoom(room) };
}

function submitSecretDrawing(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;
  if (!draw.secretSubmitted) draw.secretSubmitted = {};

  draw.secretSubmitted[userId] = true;

  const pList = Array.from(room.participants);
  const submittedCount = Object.keys(draw.secretSubmitted).filter((id) => draw.secretSubmitted[id]).length;

  if (pList.length >= 2 && submittedCount >= 2) {
    draw.secretRevealed = true;
  }

  return { room: serializeRoom(room) };
}

function resetSecretMindMatch(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;
  draw.secretElements = {};
  draw.secretSubmitted = {};
  draw.secretRevealed = false;
  return { room: serializeRoom(room) };
}

function submitMindMatchChoice(roomId, userId, { icon, color, text }) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;
  if (!draw.mindMatchChoices) draw.mindMatchChoices = {};

  draw.mindMatchChoices[userId] = {
    userId,
    icon: icon || null,
    color: color || null,
    text: text ? text.trim().toLowerCase() : null,
    submittedAt: Date.now(),
  };
  draw.status = "guess_mode";

  const pList = Array.from(room.participants);
  const choices = Object.values(draw.mindMatchChoices);

  if (pList.length >= 2 && choices.length >= 2) {
    const c1 = choices[0];
    const c2 = choices[1];

    let isMatch = false;
    let trustScore = 40;

    if (c1.icon && c2.icon && c1.icon === c2.icon) {
      isMatch = true;
      trustScore = 100;
    } else if (c1.text && c2.text && c1.text === c2.text) {
      isMatch = true;
      trustScore = 100;
    } else if (c1.color && c2.color && c1.color === c2.color) {
      isMatch = true;
      trustScore = 85;
    } else {
      isMatch = false;
      trustScore = Math.floor(Math.random() * 30) + 40;
    }

    draw.matchResult = {
      isMatch,
      trustScore,
      choice1: c1,
      choice2: c2,
    };
    draw.status = "guess_revealed";
  }

  return { room: serializeRoom(room) };
}

function resetMindMatch(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.drawing) return { error: "Room not found" };
  const draw = room.state.drawing;
  draw.mindMatchChoices = {};
  draw.matchResult = null;
  draw.status = "active";
  return { room: serializeRoom(room) };
}

// ─── Trivia Quiz ───

function submitQuizAnswer(roomId, userId, questionIndex, optionIndex) {
  const room = rooms.get(roomId);
  if (!room || !room.state.quiz) return { error: "Room not found" };
  const quiz = room.state.quiz;

  const currentQ = quiz.questions[questionIndex];
  if (!currentQ) return { error: "Question not found" };

  // Asker cannot answer their own question
  if (currentQ.askerId && String(currentQ.askerId) === String(userId)) {
    return { error: "Question creator cannot answer their own question!" };
  }

  if (!quiz.answers[userId]) quiz.answers[userId] = {};
  quiz.answers[userId][questionIndex] = optionIndex;

  if (!quiz.scores) quiz.scores = {};
  if (quiz.scores[userId] === undefined) quiz.scores[userId] = 0;

  if (Number(currentQ.correctIndex) === Number(optionIndex)) {
    quiz.scores[userId] += 10;
  } else {
    quiz.scores[userId] = Math.max(0, quiz.scores[userId] - 5);
  }

  // Move to next question index & alternate turn to the next player
  quiz.currentQuestionIndex += 1;

  const participants = Array.from(room.participants);
  const nextAsker = participants.find((id) => String(id) !== String(currentQ.askerId)) || participants[0];
  quiz.askerId = nextAsker;

  // Complete game after 6 alternating custom questions (3 questions each)
  if (quiz.questions.length >= 6) {
    quiz.status = "finished";
    const s1 = quiz.scores[participants[0]] || 0;
    const s2 = quiz.scores[participants[1]] || 0;
    if (s1 > s2) {
      quiz.winner = participants[0];
      updateSessionStats(room, participants[0], participants[1], false);
    } else if (s2 > s1) {
      quiz.winner = participants[1];
      updateSessionStats(room, participants[1], participants[0], false);
    } else {
      updateSessionStats(room, null, null, true);
    }
  }

  return { room: serializeRoom(room) };
}

function swapQuizFirstPlayer(roomId, userId, firstPlayerId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.quiz) return { error: "Room not found" };
  const quiz = room.state.quiz;
  quiz.askerId = firstPlayerId;
  return { room: serializeRoom(room) };
}

function startQuizGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.quiz) return { error: "Room not found" };
  room.state.quiz.status = "playing";
  return { room: serializeRoom(room) };
}

function submitCustomQuizQuestion(roomId, userId, { questionText, audioData, options, correctIndex }) {
  const room = rooms.get(roomId);
  if (!room || !room.state.quiz) return { error: "Room not found" };
  const quiz = room.state.quiz;

  // Ensure only the active Asker submits the question for their turn
  if (quiz.askerId && String(quiz.askerId) !== String(userId)) {
    return { error: "It is not your turn to create a question!" };
  }

  const newQuestion = {
    id: Date.now(),
    question: questionText || "Listen to Voice Question 🎙️",
    audioData: audioData || null,
    options: options || ["Option A", "Option B", "Option C", "Option D"],
    correctIndex: typeof correctIndex === "number" ? correctIndex : 0,
    askerId: userId,
  };
  if (!Array.isArray(quiz.questions)) quiz.questions = [];
  quiz.questions.push(newQuestion);
  return { room: serializeRoom(room) };
}

function restartQuizGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.quiz) return { error: "Room not found" };
  const quiz = room.state.quiz;
  quiz.currentQuestionIndex = 0;
  quiz.answers = {};
  quiz.winner = null;
  quiz.questions = [];
  Array.from(room.participants).forEach((p) => (quiz.scores[p] = 0));
  quiz.status = room.participants.size >= 2 ? "setup" : "waiting";
  return { room: serializeRoom(room) };
}

/**
 * Restart Tic-Tac-Toe game for room.
 */
function restartTicTacToeGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };
  if (!room.participants.has(userId)) return { error: "You are not in this room" };
  if (room.type !== "game" || !room.state.ticTacToe) return { error: "Not a Tic-Tac-Toe room" };

  const game = room.state.ticTacToe;
  game.board = Array(9).fill(null);
  game.winner = null;
  game.winningLine = null;
  game.isDraw = false;
  game.currentTurn = "X";
  game.status = game.players.X && game.players.O ? "setup" : "waiting";

  return { room: serializeRoom(room) };
}

/**
 * Start Tic-Tac-Toe game after turn order setup.
 */
function startTicTacToeGame(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };
  if (!room.participants.has(userId)) return { error: "You are not in this room" };
  if (room.type !== "game" || !room.state.ticTacToe) return { error: "Not a Tic-Tac-Toe room" };

  const game = room.state.ticTacToe;
  if (!game.players.X || !game.players.O) {
    return { error: "Both players must be present to start" };
  }

  game.status = "playing";
  return { room: serializeRoom(room) };
}

/**
 * Add a comment to Tic-Tac-Toe room game.
 */
function addTicTacToeComment(roomId, userId, text) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };
  if (!room.participants.has(userId)) return { error: "You are not in this room" };

  const game = room.state.ticTacToe || room.state.rps || room.state.connect4 || room.state.memoryMatch || room.state.drawing || room.state.quiz;
  if (!game) return { error: "Game not found" };

  if (!text || typeof text !== "string") return { error: "Invalid comment text" };
  const trimmed = text.trim().slice(0, 100);
  if (!trimmed) return { error: "Empty comment" };

  if (!Array.isArray(game.comments)) {
    game.comments = [];
  }

  game.comments.push({
    id: crypto.randomBytes(4).toString("hex"),
    senderId: userId,
    text: trimmed,
    timestamp: Date.now(),
  });

  if (game.comments.length > 15) {
    game.comments = game.comments.slice(-15);
  }

  return { room: serializeRoom(room) };
}

/**
 * Change or swap who plays first (X) in Tic-Tac-Toe.
 */
function swapTicTacToeFirstPlayer(roomId, userId, firstPlayerId) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };
  if (!room.participants.has(userId)) return { error: "You are not in this room" };
  if (room.type !== "game" || !room.state.ticTacToe) return { error: "Not a Tic-Tac-Toe room" };

  const game = room.state.ticTacToe;
  if (game.status === "playing" && game.board.some((cell) => cell !== null)) {
    return { error: "Cannot change turn order after game has started" };
  }

  const pX = game.players.X;
  const pO = game.players.O;
  if (!pX || !pO) return { error: "Both players must be present to change turn order" };

  let targetFirst = firstPlayerId;
  if (targetFirst === "random") {
    targetFirst = Math.random() < 0.5 ? pX : pO;
  }

  if (targetFirst === pO) {
    game.players.X = pO;
    game.players.O = pX;
  } else if (targetFirst === pX) {
    game.players.X = pX;
    game.players.O = pO;
  } else {
    game.players.X = pO;
    game.players.O = pX;
  }

  game.currentTurn = "X";
  return { room: serializeRoom(room) };
}

// ─── Couple Activities Handlers ───

function submitActivityAnswer(roomId, userId, answer) {
  const room = rooms.get(roomId);
  if (!room || !room.state.activity) return { error: "Room not found" };
  const act = room.state.activity;

  if (!act.answers) act.answers = {};
  act.answers[userId] = answer;

  if (Object.keys(act.answers).length >= Math.min(room.participants.size, 2)) {
    act.status = "revealed";
  }

  return { room: serializeRoom(room) };
}

function nextActivityPrompt(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.state.activity) return { error: "Room not found" };
  const act = room.state.activity;

  act.currentPromptIndex += 1;
  act.answers = {};
  act.status = "answering";
  act.truthOrDareChoice = null;
  act.customPromptText = null;
  act.customAudioUrl = null;
  act.questionSubmitted = false;
  act.todAnswerText = null;
  act.todAnswerAudioUrl = null;

  const pList = Array.from(room.participants);
  const nextUser = pList.find((id) => String(id) !== String(act.turnUserId)) || pList[0];
  act.turnUserId = nextUser;

  return { room: serializeRoom(room) };
}

function selectTruthOrDare(roomId, userId, choice) {
  const room = rooms.get(roomId);
  if (!room || !room.state.activity) return { error: "Room not found" };
  const act = room.state.activity;

  if (act.turnUserId && String(act.turnUserId) !== String(userId)) {
    return { error: "It is not your turn to pick Truth or Dare!" };
  }

  act.truthOrDareChoice = choice;
  act.customPromptText = null;
  act.customAudioUrl = null;
  act.questionSubmitted = false;
  act.todAnswerText = null;
  act.todAnswerAudioUrl = null;
  act.status = "answering";
  act.answers = {};

  return { room: serializeRoom(room) };
}

function submitTruthOrDareQuestion(roomId, userId, customText = null, audioData = null) {
  const room = rooms.get(roomId);
  if (!room || !room.state.activity) return { error: "Room not found" };
  const act = room.state.activity;

  if (act.turnUserId && String(act.turnUserId) === String(userId)) {
    return { error: "Only your partner can ask the question for your turn!" };
  }

  act.customPromptText = customText ? String(customText).trim() : null;
  act.customAudioUrl = audioData || null;
  act.questionSubmitted = true;

  return { room: serializeRoom(room) };
}

function submitTruthOrDareAnswer(roomId, userId, answerText = null, audioData = null) {
  const room = rooms.get(roomId);
  if (!room || !room.state.activity) return { error: "Room not found" };
  const act = room.state.activity;

  if (act.turnUserId && String(act.turnUserId) !== String(userId)) {
    return { error: "Only the active player can answer their question!" };
  }

  act.todAnswerText = answerText ? String(answerText).trim() : null;
  act.todAnswerAudioUrl = audioData || null;
  act.status = "revealed";

  return { room: serializeRoom(room) };
}

function switchActivityCategory(roomId, userId, category) {
  const room = rooms.get(roomId);
  if (!room || !room.state.activity) return { error: "Room not found" };
  const act = room.state.activity;

  act.category = category;
  act.currentPromptIndex = 0;
  act.answers = {};
  act.status = "answering";

  return { room: serializeRoom(room) };
}

function switchActivity(roomId, userId, newActivityId) {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found" };

  if (!room.participants.has(userId)) {
    return { error: "Unauthorized" };
  }

  room.type = "activity";
  initActivityRoomState(room, newActivityId, userId);

  return { room: serializeRoom(room) };
}

// ─── Watch Together Functions ───
const PRESET_WATCH_VIDEOS = [
  {
    title: "Big Buck Bunny (Open Movie)",
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  },
  {
    title: "Sintel (Open Movie)",
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
  },
  {
    title: "Tears of Steel (Open Movie)",
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
  },
  {
    title: "Elephant's Dream (Open Movie)",
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
  },
];

function initWatchRoomState(room, hostId) {
  room.state.watch = {
    mediaUrl: PRESET_WATCH_VIDEOS[0].url,
    mediaTitle: PRESET_WATCH_VIDEOS[0].title,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    hostId: hostId,
    comments: [],
  };
}

function updateWatchState(roomId, userId, { action, position, mediaUrl, mediaTitle, text, username }) {
  const room = rooms.get(roomId);
  if (!room || !room.state.watch) return { error: "Room not found" };
  const w = room.state.watch;

  if (action === "changeMedia") {
    w.mediaUrl = mediaUrl || null;
    w.mediaTitle = mediaTitle || "Custom Video";
    w.position = 0;
    w.playing = false;
    w.updatedAt = Date.now();
  } else if (action === "play") {
    w.playing = true;
    w.position = typeof position === "number" ? position : w.position;
    w.updatedAt = Date.now();
  } else if (action === "pause") {
    w.playing = false;
    w.position = typeof position === "number" ? position : w.position;
    w.updatedAt = Date.now();
  } else if (action === "seek") {
    w.position = typeof position === "number" ? position : w.position;
    w.updatedAt = Date.now();
  } else if (action === "addComment" && text) {
    if (!w.comments) w.comments = [];
    w.comments.push({
      id: `c-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      userId,
      username: username || "User",
      text: text.trim(),
      timestamp: Date.now(),
    });
    if (w.comments.length > 50) w.comments.shift();
  }

  return { room: serializeRoom(room) };
}

// ─── Listen Together (Music) Functions ───
const PRESET_MUSIC_TRACKS = [
  {
    id: "track-1",
    title: "Lofi Chill Beats",
    artist: "Open Audio",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    addedBy: "System",
  },
  {
    id: "track-2",
    title: "Acoustic Melody",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    addedBy: "System",
  },
  {
    id: "track-3",
    title: "Synthwave Breeze",
    artist: "SoundHelix",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
    addedBy: "System",
  },
];

function initMusicRoomState(room, hostId) {
  room.state.music = {
    queue: [...PRESET_MUSIC_TRACKS],
    currentTrackIndex: 0,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    comments: [],
  };
}

function updateMusicState(roomId, userId, { action, position, trackIndex, track, text, username }) {
  const room = rooms.get(roomId);
  if (!room || !room.state.music) return { error: "Room not found" };
  const m = room.state.music;

  if (action === "addTrack" && track) {
    m.queue.push(track);
  } else if (action === "removeTrack" && typeof trackIndex === "number") {
    if (trackIndex >= 0 && trackIndex < m.queue.length) {
      m.queue.splice(trackIndex, 1);
      if (m.currentTrackIndex >= m.queue.length) {
        m.currentTrackIndex = Math.max(0, m.queue.length - 1);
      }
    }
  } else if (action === "selectTrack" && typeof trackIndex === "number") {
    if (trackIndex >= 0 && trackIndex < m.queue.length) {
      m.currentTrackIndex = trackIndex;
      m.position = 0;
      m.playing = true;
      m.updatedAt = Date.now();
    }
  } else if (action === "play") {
    m.playing = true;
    m.position = typeof position === "number" ? position : m.position;
    m.updatedAt = Date.now();
  } else if (action === "pause") {
    m.playing = false;
    m.position = typeof position === "number" ? position : m.position;
    m.updatedAt = Date.now();
  } else if (action === "seek") {
    m.position = typeof position === "number" ? position : m.position;
    m.updatedAt = Date.now();
  } else if (action === "nextTrack") {
    if (m.queue.length > 0) {
      m.currentTrackIndex = (m.currentTrackIndex + 1) % m.queue.length;
      m.position = 0;
      m.playing = true;
      m.updatedAt = Date.now();
    }
  } else if (action === "prevTrack") {
    if (m.queue.length > 0) {
      m.currentTrackIndex = (m.currentTrackIndex - 1 + m.queue.length) % m.queue.length;
      m.position = 0;
      m.playing = true;
      m.updatedAt = Date.now();
    }
  } else if (action === "addComment" && text) {
    if (!m.comments) m.comments = [];
    m.comments.push({
      id: `c-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      userId,
      username: username || "User",
      text: text.trim(),
      timestamp: Date.now(),
    });
    if (m.comments.length > 50) m.comments.shift();
  }

  return { room: serializeRoom(room) };
}

module.exports = {
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
  handleDisconnect,
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
  initActivityRoomState,
  submitActivityAnswer,
  nextActivityPrompt,
  selectTruthOrDare,
  submitTruthOrDareQuestion,
  submitTruthOrDareAnswer,
  switchActivityCategory,
  switchActivity,
  initWatchRoomState,
  updateWatchState,
  initMusicRoomState,
  updateMusicState,
};
