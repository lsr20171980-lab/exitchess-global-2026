const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

// Load or initialize persistent global database
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {}
  return {
    users: {},
    adminConfig: {
      themeKey: 'emerald',
      themeName: 'Esmeralda Clásico',
      lightColor: '#eeeed2',
      darkColor: '#4e7837',
      showCoords: true,
      highlightLast: true,
      showLegalDots: true,
      kFactor: 32,
      adminPass: 'exitchess2026',
      customFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    }
  };
}

let db = loadDB();
function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (e) {}
}

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map(); // ws -> { username }
let queue = []; // [{ ws, username, elo, timeBase, timeInc }]
const activeMatches = new Map(); // matchId -> { w, b, timeBase, timeInc }

function broadcastAll(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  clients.set(ws, { username: null });
  // Send current global admin board config immediately
  ws.send(JSON.stringify({ type: 'admin_config', config: db.adminConfig }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      const uname = String(msg.username || '').trim();
      const pass = String(msg.password || '');
      if (uname.length < 2 || pass.length < 4) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Datos inválidos' }));
      }
      const key = uname.toLowerCase();
      if (!db.users[key]) {
        db.users[key] = {
          name: uname,
          password: pass,
          elo: 100,
          peakElo: 100,
          puzzleElo: 100,
          puzzlesSolved: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          eloHistory: [100],
          matches: [],
          avatar: '♗',
          avatarImg: null
        };
        saveDB();
      } else if (db.users[key].password !== pass) {
        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Contraseña incorrecta' }));
      }
      clients.set(ws, { username: key });
      const { password, ...safeUser } = db.users[key];
      ws.send(JSON.stringify({ type: 'auth_ok', user: safeUser }));
    }

    if (msg.type === 'update_profile') {
      const sess = clients.get(ws);
      if (!sess || !sess.username || !db.users[sess.username]) return;
      const u = db.users[sess.username];
      if (msg.name) u.name = String(msg.name).slice(0, 18);
      if (msg.avatar !== undefined) u.avatar = msg.avatar;
      if (msg.avatarImg !== undefined) u.avatarImg = msg.avatarImg;
      saveDB();
      const { password, ...safeUser } = u;
      ws.send(JSON.stringify({ type: 'profile_updated', user: safeUser }));
    }

    if (msg.type === 'search_users') {
      const sess = clients.get(ws);
      if (!sess || !sess.username) {
        return ws.send(JSON.stringify({ type: 'search_locked' }));
      }
      const q = String(msg.query || '').toLowerCase();
      const results = Object.values(db.users)
        .filter(u => !q || u.name.toLowerCase().includes(q))
        .slice(0, 30)
        .map(u => ({ name: u.name, elo: u.elo, avatar: u.avatar || '♗', wins: u.wins, losses: u.losses }));
      ws.send(JSON.stringify({ type: 'search_results', results }));
    }

    if (msg.type === 'admin_update') {
      if (msg.adminPass !== db.adminConfig.adminPass) {
        return ws.send(JSON.stringify({ type: 'admin_error', message: 'Clave admin incorrecta' }));
      }
      db.adminConfig = { ...db.adminConfig, ...msg.config };
      saveDB();
      broadcastAll({ type: 'admin_config', config: db.adminConfig });
    }

    if (msg.type === 'queue_join') {
      const sess = clients.get(ws);
      const uname = sess && sess.username ? db.users[sess.username].name : (msg.name || 'Invitado');
      const elo = sess && sess.username ? db.users[sess.username].elo : (msg.elo || 100);
      queue = queue.filter(q => q.ws !== ws);
      if (queue.length > 0) {
        // Match with closest ELO player in queue
        queue.sort((a, b) => Math.abs(a.elo - elo) - Math.abs(b.elo - elo));
        const opp = queue.shift();
        const matchId = 'm_' + Date.now();
        const wFirst = Math.random() < 0.5;
        const wPlayer = wFirst ? { ws, name: uname, elo } : opp;
        const bPlayer = wFirst ? opp : { ws, name: uname, elo };
        activeMatches.set(matchId, { w: wPlayer.ws, b: bPlayer.ws });
        wPlayer.ws.send(JSON.stringify({ type: 'match_found', matchId, color: 'w', oppName: bPlayer.name, oppElo: bPlayer.elo, timeBase: msg.timeBase, timeInc: msg.timeInc }));
        bPlayer.ws.send(JSON.stringify({ type: 'match_found', matchId, color: 'b', oppName: wPlayer.name, oppElo: wPlayer.elo, timeBase: msg.timeBase, timeInc: msg.timeInc }));
      } else {
        queue.push({ ws, name: uname, elo, timeBase: msg.timeBase, timeInc: msg.timeInc });
        ws.send(JSON.stringify({ type: 'queue_waiting' }));
      }
    }

    if (msg.type === 'move' && msg.matchId) {
      const m = activeMatches.get(msg.matchId);
      if (!m) return;
      const target = m.w === ws ? m.b : m.w;
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'opp_move', move: msg.move }));
      }
    }

    if (msg.type === 'match_end' && msg.matchId) {
      const m = activeMatches.get(msg.matchId);
      if (!m) return;
      const target = m.w === ws ? m.b : m.w;
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'opp_match_end', result: msg.result, reason: msg.reason }));
      }
      activeMatches.delete(msg.matchId);
    }
  });

  ws.on('close', () => {
    queue = queue.filter(q => q.ws !== ws);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`ExitChess Global Server corriendo en http://localhost:${PORT}`);
});