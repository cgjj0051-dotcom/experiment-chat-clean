const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { google } = require('googleapis');

// ===== Google Sheets設定 =====
console.log("GOOGLE_CREDENTIALS exists:", !!process.env.GOOGLE_CREDENTIALS);

const keys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: keys,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ★ここは自分のスプシID
const SPREADSHEET_ID = '1RE7Rxb0050RbXhJZvhaPwjbSRIE_IEgiONAE-IrqVF8';

// ★シート名に合わせる（重要）
const SHEET_NAME = 'Sheet1';

// ===== サーバー設定 =====
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const experiments = {};

const LOG_DIR = './logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// ===== ボット発話 =====
const botInterventions = [
  {
    category: "ELICIT_OPINION",
    polite: "なるほど、わかりました。それについてお二人はどう考えますか。",
    casual: "なるほど、わかった。それについて二人はどう思う。",
    kansai: "なるほど、わかった。それについて二人はどない思う。"
  },
  {
    category: "PROMPT_ELABORATION",
    polite: "今の話は興味深いです。もう少し詳しく教えてもらえますか。",
    casual: "今の話はおもしろいね。もう少し詳しく教えてくれる。",
    kansai: "今の話はおもろいな。もうちょい詳しく教えてくれる。"
  },
  {
    category: "PERSPECTIVE_SHIFT",
    polite: "ただいまの点について、別の視点からはどのように見えますか。",
    casual: "今の点について、別の視点からはどんなふうに見える。",
    kansai: "今の点について、別の見方やったらどんな風に見える。"
  }
];

// ===== ログ保存 =====
function writeLog(roomId, logData) {
  const jsonPath = path.join(LOG_DIR, `log_${roomId}.json`);
  fs.appendFileSync(jsonPath, JSON.stringify(logData) + '\n');
}

// ===== スプレッドシート保存 =====
async function saveToSheet(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME,
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

// ===== Socket処理 =====
io.on('connection', (socket) => {

  console.log("接続:", socket.id);

  // 実験作成
  socket.on('create_experiment', (data) => {
    const roomId = uuidv4().substring(0, 8);

    experiments[roomId] = {
      roomId,
      condition: data.botConfig,
      X: parseInt(data.stagnationX),
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

  // 部屋参加
  socket.on('join_room', ({ roomId, playerNum }) => {
    const exp = experiments[roomId];
    if (!exp) return;

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerNum = playerNum;
    socket.userName = playerNum === "1" ? exp.p1Name : exp.p2Name;

    socket.emit('room_info', {
      userName: socket.userName,
      protocol: exp.protocol
    });

    resetStagnationTimer(roomId);
  });

  // メッセージ送信
  socket.on('chat_message', (data) => {

    console.log("受信:", data.message);

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

    resetStagnationTimer(exp.roomId);
  });

  // 停滞検知
  function resetStagnationTimer(roomId) {
    const exp = experiments[roomId];
    if (!exp) return;

    if (exp.stagnationTimer) clearTimeout(exp.stagnationTimer);

    exp.stagnationTimer = setTimeout(() => {
      handleStall(roomId);
    }, exp.X * 1000);
  }

  function handleStall(roomId) {
    const exp = experiments[roomId];
    if (!exp) return;

    if (exp.condition === 'none') return;

    const category = botInterventions[exp.interventionCount % botInterventions.length];
    const botMsg = category[exp.condition];

    exp.interventionCount++;

    io.to(roomId).emit('chat_message', {
      userName: 'AI ぶんちゃん',
      message: botMsg,
      role: 'bot'
    });

    resetStagnationTimer(roomId);
  }
});

// ===== ポート（Render対応） =====
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});