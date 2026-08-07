const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const httpServer = require('http').createServer(app);
const io = new Server(httpServer);
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// TURN credentials are intentionally kept in environment variables rather than source control.
// Browsers must receive them to make WebRTC connections, so use credentials scoped to this app.
app.get('/api/ice', (_req, res) => {
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((url) => url.trim()).filter(Boolean);
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const iceServers = stunUrls.length ? [{ urls: stunUrls }] : [];
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers, turnEnabled: turnUrls.length > 0 });
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    const safeRoomId = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const safeName = String(name).trim().slice(0, 32) || 'Гость';
    if (!safeRoomId) return;

    socket.data.roomId = safeRoomId;
    socket.data.name = safeName;
    socket.join(safeRoomId);
    if (!rooms.has(safeRoomId)) rooms.set(safeRoomId, new Map());
    const room = rooms.get(safeRoomId);
    const peers = [...room.entries()].map(([id, peer]) => ({ id, ...peer }));
    room.set(socket.id, { name: safeName });
    socket.emit('room-peers', peers);
    socket.to(safeRoomId).emit('peer-joined', { id: socket.id, name: safeName });
  });

  socket.on('signal', ({ to, data }) => {
    if (to && data) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const { roomId, name } = socket.data;
    if (!roomId || !rooms.has(roomId)) return;
    rooms.get(roomId).delete(socket.id);
    socket.to(roomId).emit('peer-left', { id: socket.id, name });
    if (rooms.get(roomId).size === 0) rooms.delete(roomId);
  });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => console.log(`Voxel Voice is running on http://localhost:${port}`));
