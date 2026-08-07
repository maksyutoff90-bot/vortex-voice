const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const httpServer = require('http').createServer(app);
const io = new Server(httpServer);
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

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

function cleanId(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
function cleanName(value, fallback) { return String(value || '').trim().slice(0, 32) || fallback; }
function createRoom() {
  return { channels: new Map([
    ['voice-general', { id: 'voice-general', name: 'Общий голосовой', type: 'voice', members: new Map(), messages: [] }],
    ['text-general', { id: 'text-general', name: 'Общий чат', type: 'text', members: new Map(), messages: [] }]
  ]) };
}
function channelList(room) {
  return [...room.channels.values()].map(({ id, name, type, messages }) => ({ id, name, type, messages: type === 'text' ? messages : undefined }));
}
function channelKey(roomId, channelId) { return `voice:${roomId}:${channelId}`; }

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name, channelId = 'voice-general' }) => {
    const safeRoomId = cleanId(roomId); const safeName = cleanName(name, 'Гость');
    if (!safeRoomId) return;
    if (!rooms.has(safeRoomId)) rooms.set(safeRoomId, createRoom());
    const room = rooms.get(safeRoomId);
    let channel = room.channels.get(channelId);
    if (!channel || channel.type !== 'voice') channel = room.channels.get('voice-general');
    socket.data.roomId = safeRoomId; socket.data.name = safeName; socket.data.channelId = channel.id;
    socket.join(safeRoomId); socket.join(channelKey(safeRoomId, channel.id));
    const peers = [...channel.members.entries()].map(([id, peer]) => ({ id, ...peer }));
    channel.members.set(socket.id, { name: safeName });
    socket.emit('room-channels', channelList(room));
    socket.emit('room-peers', peers);
    socket.to(channelKey(safeRoomId, channel.id)).emit('peer-joined', { id: socket.id, name: safeName });
  });

  socket.on('create-channel', ({ name, type }) => {
    const { roomId } = socket.data; if (!roomId || !['voice', 'text'].includes(type)) return;
    const room = rooms.get(roomId); const channelName = cleanName(name, type === 'voice' ? 'Новый голосовой' : 'Новый чат');
    const id = `${type}-${cleanId(channelName) || 'channel'}-${Math.random().toString(36).slice(2, 7)}`;
    room.channels.set(id, { id, name: channelName, type, members: new Map(), messages: [] });
    io.to(roomId).emit('room-channels', channelList(room));
  });

  socket.on('switch-voice-channel', ({ channelId }) => {
    const { roomId, name, channelId: oldId } = socket.data; const room = rooms.get(roomId); const next = room?.channels.get(channelId);
    if (!room || !next || next.type !== 'voice' || next.id === oldId) return;
    const old = room.channels.get(oldId); old?.members.delete(socket.id);
    socket.to(channelKey(roomId, oldId)).emit('peer-left', { id: socket.id, name });
    socket.leave(channelKey(roomId, oldId));
    const peers = [...next.members.entries()].map(([id, peer]) => ({ id, ...peer }));
    socket.data.channelId = next.id; socket.join(channelKey(roomId, next.id)); next.members.set(socket.id, { name });
    socket.emit('room-peers', peers);
    socket.to(channelKey(roomId, next.id)).emit('peer-joined', { id: socket.id, name });
  });

  socket.on('send-message', ({ channelId, text }) => {
    const room = rooms.get(socket.data.roomId); const channel = room?.channels.get(channelId); const message = String(text || '').trim().slice(0, 1000);
    if (!channel || channel.type !== 'text' || !message) return;
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: socket.data.name, text: message, at: Date.now() };
    channel.messages.push(item); if (channel.messages.length > 100) channel.messages.shift();
    io.to(socket.data.roomId).emit('chat-message', { channelId, message: item });
  });

  socket.on('signal', ({ to, data }) => { if (to && data) io.to(to).emit('signal', { from: socket.id, data }); });

  socket.on('disconnect', () => {
    const { roomId, name, channelId } = socket.data; const room = rooms.get(roomId); const channel = room?.channels.get(channelId);
    if (!room || !channel) return;
    channel.members.delete(socket.id); socket.to(channelKey(roomId, channelId)).emit('peer-left', { id: socket.id, name });
    if ([...room.channels.values()].every((item) => item.members.size === 0)) rooms.delete(roomId);
  });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => console.log(`Vortex Voice is running on http://localhost:${port}`));
