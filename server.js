const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { google } = require('googleapis');
console.log("GOOGLE_CREDENTIALS exists:", !!process.env.GOOGLE_CREDENTIALS);
const keys = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: keys,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1RE7Rxb0050RbXhJZvhaPwjbSRIE_IEgiONAE-IrqVF8';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const LOG_DIR = './logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

app.use(express.static('public'));

const experiments = {};

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

function escapeCSV(val) {
    if (val === null || val === undefined) return '';
    let str = String(val);
    if (/[",\n\r]/.test(str)) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function writeLog(roomId, logData) {
    const csvPath = path.join(LOG_DIR, `log_${roomId}.csv`);
    const jsonPath = path.join(LOG_DIR, `log_${roomId}.json`);

    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(csvPath, Object.keys(logData).join(',') + '\n');
    }
    fs.appendFileSync(csvPath, Object.values(logData).map(escapeCSV).join(',') + '\n');
    fs.appendFileSync(jsonPath, JSON.stringify(logData) + '\n');
}

// ⭐ スプシ保存（修正版）
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

io.on('connection', (socket) => {

    socket.on('create_experiment', (data) => {
        const roomId = uuidv4().substring(0, 8);
        const nowISO = new Date().toISOString();

        experiments[roomId] = {
            roomId,
            condition: data.botConfig,
            X: parseInt(data.stagnationX),
            N: parseInt(data.limitN),
            C: parseInt(data.cooldownC),
            protocol: data.protocol,
            p1Name: data.p1Name,
            p2Name: data.p2Name,
            startTime: Date.now(),
            messageSeq: 0,
            lastMsgTime: Date.now(),
            lastHumanMsgTime: Date.now(),
            interventionCount: 0,
            lastInterventionTime: 0,
            stagnationTimer: null
        };

        writeLog(roomId, {
            experimentId: roomId,
            condition: data.botConfig,
            timestamp: nowISO,
            senderType: 'system',
            senderId: 'system',
            senderName: 'SYSTEM',
            messageText: `START_EXP`,
            messageSeq: 0,
            timeSinceLastHumanMsgMs: 0,
            timeSinceLastMsgMs: 0,
            stallEventId: '',
            interventionReason: 'INIT',
            interventionCategory: 'NONE'
        });

        socket.emit('experiment_created', { roomId });
    });

    socket.on('join_room', ({ roomId, playerNum }) => {
        console.log("join_room:", roomId, playerNum);
        const exp = experiments[roomId];
        if (!exp) return;

        socket.join(roomId);

        console.log("join成功:", roomId);

        socket.roomId = roomId;
        socket.playerNum = playerNum;
        socket.userName = playerNum === "1" ? exp.p1Name : exp.p2Name;

        socket.emit('room_info', {
            userName: socket.userName,
            protocol: exp.protocol
        });

        resetStagnationTimer(roomId);
    });

    socket.on('chat_message', (data) => {

   
        console.log("chat_message受信:", data.message);

        const exp = experiments[socket.roomId];
        if (!exp) return;
     
        console.log("emit先:", exp.roomId);

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

    function resetStagnationTimer(roomId) {
        const exp = experiments[roomId];
        if (!exp) return;

        if (exp.stagnationTimer) clearTimeout(exp.stagnationTimer);

        exp.stagnationTimer = setTimeout(() => {
            handleStallTrigger(roomId);
        }, exp.X * 1000);
    }

    function handleStallTrigger(roomId) {
        const exp = experiments[roomId];
        const now = Date.now();
        const stallId = uuidv4().substring(0, 6);
        exp.messageSeq++;

        let shouldSpeak = exp.condition !== 'none';

        const categoryObj = botInterventions[exp.interventionCount % botInterventions.length];

        const log = {
            experimentId: exp.roomId,
            condition: exp.condition,
            timestamp: new Date().toISOString(),
            senderType: shouldSpeak ? 'bot' : 'system',
            senderId: 'bot',
            senderName: 'AI ぶんちゃん',
            messageText: '',
            messageSeq: exp.messageSeq,
            timeSinceLastHumanMsgMs: now - exp.lastHumanMsgTime,
            timeSinceLastMsgMs: now - exp.lastMsgTime,
            stallEventId: stallId,
            interventionReason: 'STALL_TRIGGER',
            interventionCategory: shouldSpeak ? categoryObj.category : 'NONE'
        };

        if (shouldSpeak) {
            const botMsg = categoryObj[exp.condition];
            log.messageText = botMsg;

            exp.interventionCount++;
            exp.lastInterventionTime = now;
            exp.lastMsgTime = now;

            saveToSheet(log).catch(console.error);
            writeLog(roomId, log);

            io.to(roomId).emit('chat_message', {
                userName: 'AI ぶんちゃん',
                message: botMsg,
                role: 'bot'
            });

            resetStagnationTimer(roomId);
        } else {
            writeLog(roomId, log);
        }
    }
});

server.listen(3000, () => {
    console.log('🚀 Server running on http://localhost:3000');
});