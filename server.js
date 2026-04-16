const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

console.log("GOOGLE_CREDENTIALS exists:", !!process.env.GOOGLE_CREDENTIALS);

// Google認証
const keys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: keys,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1RE7Rxb0050RbXhJZvhaPwjbSRIE_IEgiONAE-IrqVF8';

// server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// logs
const LOG_DIR = './logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

app.use(express.static('public'));

const experiments = {};

// ボット
const botInterventions = [
  {
    category: "ELICIT_OPINION",
    polite: "なるほど、それについてお二人はどう考えますか。",
    casual: "それについてどう思う？",
    kansai: "それについてどない思う？"
  },
  {
    category: "PROMPT_ELABORATION",
    polite: "もう少し詳しく教えてもらえますか。",
    casual: "もうちょい詳しく教えて。",
    kansai: "もうちょい詳しく教えてや。"
  },
  {
    category: "PERSPECTIVE_SHIFT",
    polite: "別の視点ではどう見えますか。",
    casual: "別の見方はどう？",
    kansai: "別の見方やとどうや？"
  }
];

// log
function writeLog(roomId, logData) {
  const csvPath = path.join(LOG_DIR, `log_${roomId}.csv`);
  const jsonPath = path.join(LOG_DIR, `log_${roomId}.json`);

  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, Object.keys(logData).join(',') + '\n');
  }

  fs.appendFileSync(csvPath, Object.values(logData).join(',') + '\n');
  fs.appendFileSync(jsonPath, JSON.stringify(logData) + '\n');
}

// スプシ保存
async function saveToSheet(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        data.experimentId,
        data.condition,
        data.timestamp,
        data.senderType,
        data.senderId,
        data.senderName,
        data.messageText,
        data.messageSeq,
        data.timeSinceLastHumanMsgMs,
        data.timeSinceLastMsgMs,
        data.stallEventId,
        data.interventionReason,
        data.interventionCategory
      ]]
    }
  });
}

// socket
io.on('connection', (socket) => {

  // 実験作成
  socket.on('create_experiment', (data) => {
    const roomId = uuidv4().substring(0, 8);

    experiments[roomId] = {
      roomId,
      condition: data.botConfig,
      X: parseInt(data.stagnationX),
      N: parseInt(data.limitN),
      C: parseInt(data.cooldownC),
      protocol: data.protocol,
      p1Name: data.p1Name,
      p2Name: data.p2Name,
      messageSeq: 0,
      lastMsgTime: Date.now(),
      lastHumanMsgTime: Date.now(),
      interventionCount: 0,
      stagnationTimer: null
    };

    socket.emit('experiment_created', { roomId });
  });

  // 参加
  socket.on('join_room', ({ roomId, playerNum }) => {
    console.log("JOIN受信:", roomId, playerNum);

    const exp = experiments[roomId];
    if (!exp) {
        console.log("room存在しない");
        return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerNum = playerNum;
    socket.userName = playerNum === "1" ? exp.p1Name : exp.p2Name;

    console.log("JOIN成功:", roomId);

    socket.emit('room_info', {
        userName: socket.userName,
        protocol: exp.protocol
    });

    resetTimer(roomId);
});

  // メッセージ受信
  socket.on('chat_message', (data) => {
    const exp = experiments[socket.roomId];
    if (!exp) return;

    const now = Date.now();
    exp.messageSeq++;

    const log = {
      experimentId: exp.roomId,
      condition: exp.condition,
      timestamp: new Date().toISOString(),
      senderType: 'human',
      senderId: `p${socket.playerNum}`,
      senderName: socket.userName,
      messageText: data.message,
      messageSeq: exp.messageSeq,
      timeSinceLastHumanMsgMs: now - exp.lastHumanMsgTime,
      timeSinceLastMsgMs: now - exp.lastMsgTime,
      stallEventId: '',
      interventionReason: 'NONE',
      interventionCategory: 'NONE'
    };

    saveToSheet(log).catch(console.error);
    writeLog(exp.roomId, log);

    exp.lastMsgTime = now;
    exp.lastHumanMsgTime = now;

    io.to(exp.roomId).emit('chat_message', {
      userName: socket.userName,
      message: data.message,
      role: 'human'
    });

    resetTimer(exp.roomId);
  });

  // タイマー
  function resetTimer(roomId) {
    const exp = experiments[roomId];
    if (!exp) return;

    if (exp.stagnationTimer) clearTimeout(exp.stagnationTimer);

    exp.stagnationTimer = setTimeout(() => {
      handleStall(roomId);
    }, exp.X * 1000);
  }

  // ボット介入
  function handleStall(roomId) {
    const exp = experiments[roomId];
    if (!exp) return;

    const now = Date.now();
    const stallId = uuidv4().substring(0, 6);

    const category = botInterventions[exp.interventionCount % botInterventions.length];
    const botMsg = category[exp.condition];

    const log = {
      experimentId: exp.roomId,
      condition: exp.condition,
      timestamp: new Date().toISOString(),
      senderType: exp.condition === 'none' ? 'system' : 'bot',
      senderId: 'bot',
      senderName: 'AI ぶんちゃん',
      messageText: exp.condition === 'none' ? '' : botMsg,
      messageSeq: exp.messageSeq,
      timeSinceLastHumanMsgMs: now - exp.lastHumanMsgTime,
      timeSinceLastMsgMs: now - exp.lastMsgTime,
      stallEventId: stallId,
      interventionReason: 'STALL_TRIGGER',
      interventionCategory: category.category
    };

    writeLog(roomId, log);

    if (exp.condition !== 'none') {
      io.to(roomId).emit('chat_message', {
        userName: 'AI ぶんちゃん',
        message: botMsg,
        role: 'bot'
      });
    }

    exp.interventionCount++;
    resetTimer(roomId);
  }
});

server.listen(PORT, () => {
  console.log('Server running on', PORT);
});