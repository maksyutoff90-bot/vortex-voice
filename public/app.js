const socket = io();
const roomFromUrl = new URLSearchParams(location.search).get('room');
let roomId = roomFromUrl || crypto.randomUUID().slice(0, 8);
function normalizeRoom(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
function setRoomId(value) {
  roomId = normalizeRoom(value) || roomId;
  const url = new URL(location.href); url.searchParams.set('room', roomId);
  history.replaceState({}, '', url);
  el('channelTitle').textContent = `Комната #${roomId}`;
  el('roomLabel').textContent = `# ${roomId}`;
}
if (!roomFromUrl) {
  const url = new URL(location.href); url.searchParams.set('room', roomId);
  history.replaceState({}, '', url);
}

const peers = new Map();
let myName = '';
let micStream;
let screenStream;
let muted = false;
let listenOnly = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const el = (id) => document.getElementById(id);

setRoomId(roomId);
const dialog = el('joinDialog');
dialog.showModal();

const roomInput = document.createElement('input');
roomInput.id = 'roomInput'; roomInput.maxLength = 64; roomInput.autocomplete = 'off';
roomInput.placeholder = 'Например, друзья-123'; roomInput.value = roomId;
const roomField = document.createElement('label'); roomField.textContent = 'Название или номер комнаты';
roomField.append(roomInput);
el('nameInput').closest('label').before(roomField);

let channels = [];
let activeTextChannel = 'text-general';
let activeVoiceChannel = 'voice-general';
const extraStyles = document.createElement('style');
extraStyles.textContent = '.channels-panel{margin-top:22px}.channel-actions{display:flex;gap:7px;margin:0 8px 10px}.channel-actions button{border:0;border-radius:7px;background:#292934;color:#ddd;padding:7px;font:700 11px Manrope;cursor:pointer}.channel-item{width:100%;border:0;background:transparent;color:#c3c3ce;text-align:left;padding:8px;border-radius:7px;font:600 12px Manrope;cursor:pointer}.channel-item.active{background:#292833;color:#fff}.text-chat{margin:0 38px 0;padding:14px;border-bottom:1px solid #2e2e39;background:#15151b}.text-chat-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:800}.chat-messages{height:115px;overflow:auto;margin:10px 0;display:flex;flex-direction:column;gap:6px;font-size:12px}.chat-message{background:#202029;padding:7px 9px;border-radius:7px}.chat-message b{color:#a58cff;margin-right:6px}.chat-form{display:flex;gap:8px}.chat-form input{margin:0;padding:8px;font-size:12px}.chat-form button{margin:0;width:auto;padding:8px 12px}@media(max-width:700px){.text-chat{margin:0 18px}.chat-messages{height:100px}}';
extraStyles.textContent += '.chat-file{display:inline-block;margin-top:6px;color:#c9beff;font-weight:700;text-decoration:none}';
document.head.append(extraStyles);
const channelsPanel = document.createElement('section'); channelsPanel.className = 'channels-panel';
const channelsHeading = document.createElement('p'); channelsHeading.className = 'side-heading'; channelsHeading.textContent = 'КАНАЛЫ'; channelsPanel.append(channelsHeading);
const channelActions = document.createElement('div'); channelActions.className = 'channel-actions';
const addVoice = document.createElement('button'); addVoice.textContent = '+ Голосовой';
const addText = document.createElement('button'); addText.textContent = '+ Чат';
channelActions.append(addVoice, addText); channelsPanel.append(channelActions);
const channelList = document.createElement('div'); channelsPanel.append(channelList);
document.querySelector('.sidebar').insertBefore(channelsPanel, document.querySelector('.side-bottom'));

const chatPanel = document.createElement('section'); chatPanel.className = 'text-chat';
const chatHead = document.createElement('div'); chatHead.className = 'text-chat-head';
const chatTitle = document.createElement('span'); chatHead.append(chatTitle);
const messages = document.createElement('div'); messages.className = 'chat-messages';
const chatForm = document.createElement('form'); chatForm.className = 'chat-form';
const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.hidden = true;
const attachButton = document.createElement('button'); attachButton.className = 'button secondary'; attachButton.type = 'button'; attachButton.title = 'Прикрепить файл'; attachButton.textContent = '📎';
const chatInput = document.createElement('input'); chatInput.maxLength = 1000; chatInput.placeholder = 'Написать сообщение…';
const sendButton = document.createElement('button'); sendButton.className = 'button secondary'; sendButton.type = 'submit'; sendButton.textContent = 'Отправить';
chatForm.append(fileInput, attachButton, chatInput, sendButton); chatPanel.append(chatHead, messages, chatForm);
document.querySelector('.content').insertBefore(chatPanel, el('stage'));

function renderTextChat() {
  const channel = channels.find((item) => item.id === activeTextChannel && item.type === 'text') || channels.find((item) => item.type === 'text');
  if (!channel) { chatPanel.hidden = true; return; }
  activeTextChannel = channel.id; chatPanel.hidden = false; chatTitle.textContent = `# ${channel.name}`;
  messages.replaceChildren(...(channel.messages || []).map((message) => { const item = document.createElement('div'); item.className = 'chat-message'; const author = document.createElement('b'); author.textContent = message.name; item.append(author, document.createTextNode(message.text || '')); if (message.file) { const file = document.createElement('a'); file.className = 'chat-file'; file.href = message.file.url; file.download = message.file.name; file.textContent = `📎 ${message.file.name}`; item.append(document.createElement('br'), file); } return item; }));
  messages.scrollTop = messages.scrollHeight;
}
function renderChannels() {
  channelList.replaceChildren();
  for (const channel of channels) {
    const button = document.createElement('button'); button.className = `channel-item ${channel.type === 'voice' && channel.id === activeVoiceChannel ? 'active' : ''}`;
    button.textContent = `${channel.type === 'voice' ? '🔊' : '💬'} ${channel.name}`;
    button.addEventListener('click', () => {
      if (channel.type === 'voice') { activeVoiceChannel = channel.id; socket.emit('switch-voice-channel', { channelId: channel.id }); renderChannels(); }
      else { activeTextChannel = channel.id; renderTextChat(); }
    });
    channelList.append(button);
  }
  renderTextChat();
}
function addChannel(type) { const name = prompt(type === 'voice' ? 'Название голосового канала' : 'Название текстового чата'); if (name?.trim()) socket.emit('create-channel', { type, name: name.trim() }); }
addVoice.addEventListener('click', () => addChannel('voice'));
addText.addEventListener('click', () => addChannel('text'));
chatForm.addEventListener('submit', (event) => { event.preventDefault(); const text = chatInput.value.trim(); if (!text) return; socket.emit('send-message', { channelId: activeTextChannel, text }); chatInput.value = ''; });
attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]; if (!file) return; fileInput.value = '';
  if (file.size > 25 * 1024 * 1024) { alert('Максимальный размер файла — 25 МБ.'); return; }
  attachButton.disabled = true; attachButton.textContent = '…';
  try {
    const response = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
    if (!response.ok) throw new Error('upload failed');
    const uploaded = await response.json();
    socket.emit('send-message', { channelId: activeTextChannel, file: uploaded });
  } catch { alert('Не удалось загрузить файл. Попробуйте ещё раз.'); }
  finally { attachButton.disabled = false; attachButton.textContent = '📎'; }
});

const iceConfigReady = fetch('/api/ice')
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then((config) => { if (Array.isArray(config.iceServers) && config.iceServers.length) iceServers = config.iceServers; })
  .catch(() => console.warn('Using default STUN configuration'));

function initials(name) { return name.trim().slice(0, 1).toUpperCase() || '?'; }
function updateMembers() {
  const people = [{ id: 'me', name: `${myName} (вы)` }, ...[...peers.entries()].map(([id, p]) => ({ id, name: p.name }))];
  el('memberCount').textContent = people.length;
  el('members').innerHTML = people.map(p => `<div class="member"><span class="member-avatar">${initials(p.name)}</span>${escapeHtml(p.name)}</div>`).join('');
  el('emptyState')?.remove();
}
function escapeHtml(value) { const d = document.createElement('div'); d.textContent = value; return d.innerHTML; }
function addCard(id, name, stream, screen = false) {
  document.getElementById(`card-${id}`)?.remove();
  const card = document.createElement('article'); card.className = `video-card ${screen ? 'screen' : ''}`; card.id = `card-${id}`;
  let video;
  if (stream) { video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = screen; video.srcObject = stream; video.play().catch(() => {}); card.append(video); }
  else { const avatar = document.createElement('div'); avatar.className = 'avatar-stage'; avatar.textContent = initials(name); card.append(avatar); }
  if (screen) {
    const tag = document.createElement('span'); tag.className = 'screen-tag'; tag.textContent = `${name} показывает экран`; card.append(tag);
    const fullscreen = document.createElement('button'); fullscreen.className = 'fullscreen-btn'; fullscreen.type = 'button'; fullscreen.title = 'На весь экран'; fullscreen.setAttribute('aria-label', 'На весь экран'); fullscreen.textContent = '⛶';
    fullscreen.addEventListener('click', async () => { try { if (card.requestFullscreen) await card.requestFullscreen(); else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen(); } catch (error) { console.warn('Fullscreen error', error); } });
    card.append(fullscreen);
  }
  const label = document.createElement('span'); label.className = 'participant-name'; label.textContent = name; card.append(label); el('stage').append(card);
}
async function negotiate(peerId, peer) {
  const { pc } = peer;
  if (pc.signalingState !== 'stable') return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, data: { description: pc.localDescription } });
  } catch (error) { console.warn('Negotiation error', error); }
}
function unlockRemoteAudio() {
  document.querySelectorAll('audio[data-remote-audio]').forEach((audio) => { audio.muted = false; audio.play().catch(() => {}); });
  document.getElementById('audioUnlock')?.remove();
}
function addRemoteAudio(peerId, trackId, stream) {
  const id = `audio-${peerId}-${trackId}`;
  if (document.getElementById(id)) return;
  const audio = document.createElement('audio'); audio.id = id; audio.autoplay = true; audio.playsInline = true; audio.dataset.remoteAudio = 'true'; audio.dataset.peer = peerId; audio.srcObject = stream;
  audio.play().catch(() => {
    if (document.getElementById('audioUnlock')) return;
    const button = document.createElement('button'); button.id = 'audioUnlock'; button.className = 'audio-unlock'; button.textContent = 'Нажмите, чтобы включить звук'; button.addEventListener('click', unlockRemoteAudio); document.body.append(button);
  });
  document.body.append(audio);
}
async function createPeer(peerId, name, makeOffer) {
  if (peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection({ iceServers });
  // Keep a video m-line in every offer. Otherwise a late joiner sends an
  // audio-only offer and the current screen sharer cannot return video.
  const videoTransceiver = pc.addTransceiver('video', { direction: screenStream ? 'sendrecv' : 'recvonly' });
  const peer = { pc, name, videoTransceiver, hasRemoteVideo: false, pendingCandidates: [], screenSyncTimer: null };
  peers.set(peerId, peer); updateMembers();
  micStream?.getTracks().forEach(t => pc.addTrack(t, micStream));
  const currentScreenTrack = screenStream?.getVideoTracks()[0];
  if (currentScreenTrack) await videoTransceiver.sender.replaceTrack(currentScreenTrack);
  pc.onicecandidate = ({ candidate }) => candidate && socket.emit('signal', { to: peerId, data: { candidate } });
  pc.ontrack = ({ streams, track }) => {
    // Tracks attached through a pre-created transceiver may not have an MSID,
    // especially in mobile browsers. Build a stream from the track in that case.
    const stream = streams[0] || new MediaStream([track]);
    const isScreen = track.kind === 'video';
    if (isScreen) {
      peer.hasRemoteVideo = true;
      clearTimeout(peer.screenSyncTimer);
      addCard(`${peerId}-screen`, name, stream, true);
      // Safari can initially deliver a muted receiver track. Retry playback
      // when it becomes live without requiring the viewer to reconnect.
      track.addEventListener('unmute', () => addCard(`${peerId}-screen`, name, stream, true), { once: true });
    }
    else { addCard(`${peerId}-audio`, name, null); addRemoteAudio(peerId, track.id, stream); }
  };
  pc.onconnectionstatechange = () => {
    if (['failed','closed'].includes(pc.connectionState)) { removePeer(peerId); return; }
    if (pc.connectionState === 'connected' && !peer.hasRemoteVideo) {
      clearTimeout(peer.screenSyncTimer);
      peer.screenSyncTimer = setTimeout(() => {
        if (pc.connectionState === 'connected' && !peer.hasRemoteVideo) socket.emit('signal', { to: peerId, data: { requestScreen: true } });
      }, 1800);
    }
  };
  if (makeOffer) await negotiate(peerId, peer);
  return peer;
}
function removePeer(id) { const peer = peers.get(id); clearTimeout(peer?.screenSyncTimer); peer?.pc.close(); peers.delete(id); document.getElementById(`card-${id}-audio`)?.remove(); document.getElementById(`card-${id}-screen`)?.remove(); document.querySelectorAll(`audio[data-peer="${id}"]`).forEach((audio) => audio.remove()); updateMembers(); }
async function getMicrophone() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } }, video: false });
    return true;
  } catch {
    // A viewer does not need microphone permission to receive screen sharing.
    listenOnly = true;
    return false;
  }
}
socket.on('room-peers', async list => { for (const id of [...peers.keys()]) removePeer(id); for (const p of list) await createPeer(p.id, p.name, true); });
socket.on('peer-joined', ({ id, name }) => { createPeer(id, name, false); });
socket.on('peer-left', ({ id }) => removePeer(id));
socket.on('room-channels', (list) => { channels = Array.isArray(list) ? list : []; renderChannels(); });
socket.on('chat-message', ({ channelId, message }) => { const channel = channels.find((item) => item.id === channelId); if (!channel || channel.type !== 'text') return; channel.messages ||= []; channel.messages.push(message); if (channel.messages.length > 100) channel.messages.shift(); if (channelId === activeTextChannel) renderTextChat(); });
socket.on('signal', async ({ from, data }) => {
  let peer = peers.get(from);
  if (!peer) peer = await createPeer(from, 'Гость', false);
  try {
    if (data.requestScreen) {
      const track = screenStream?.getVideoTracks()[0];
      if (track) { await peer.videoTransceiver.sender.replaceTrack(track); peer.videoTransceiver.direction = 'sendrecv'; await negotiate(from, peer); }
      return;
    }
    if (data.description) {
      await peer.pc.setRemoteDescription(data.description);
      for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
      if (data.description.type === 'offer') { const answer = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(answer); socket.emit('signal', { to: from, data: { description: peer.pc.localDescription } }); }
    } else if (data.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
      else peer.pendingCandidates.push(data.candidate);
    }
  } catch (error) { console.error('WebRTC signal error', error); }
});
socket.on('connect', () => { el('connectionText').textContent = listenOnly ? 'Режим просмотра без микрофона' : 'В голосовом канале'; });
socket.on('disconnect', () => { el('connectionText').textContent = 'Переподключение…'; });

el('joinForm').addEventListener('submit', async (e) => { e.preventDefault(); setRoomId(roomInput.value); myName = el('nameInput').value.trim(); if (!myName) return; await iceConfigReady; el('meName').textContent = myName; const hasMicrophone = await getMicrophone(); socket.emit('join-room', { roomId, name: myName, channelId: activeVoiceChannel }); dialog.close(); if (!hasMicrophone) { el('connectionText').textContent = 'Режим просмотра без микрофона'; el('micBtn').classList.add('off'); el('micBtn').disabled = true; } addCard('me-audio', `${myName} (вы)`, null); updateMembers(); });
el('micBtn').addEventListener('click', () => { if (!micStream) return; muted = !muted; micStream.getAudioTracks().forEach(t => t.enabled = !muted); el('micBtn').classList.toggle('off', muted); el('micBtn').textContent = muted ? '🔇' : '🎙'; });
el('shareLink').addEventListener('click', async () => { await navigator.clipboard.writeText(location.href); const b = el('shareLink'); const old = b.textContent; b.textContent = 'Ссылка скопирована'; setTimeout(() => b.textContent = old, 1800); });
async function stopScreenShare() {
  if (!screenStream) return;
  const tracks = screenStream.getTracks();
  for (const [peerId, peer] of peers) {
    await peer.videoTransceiver?.sender.replaceTrack(null);
    if (peer.videoTransceiver) peer.videoTransceiver.direction = 'recvonly';
    await negotiate(peerId, peer);
  }
  tracks.forEach(track => track.stop());
  screenStream = null; el('screenBtn').classList.remove('active'); document.getElementById('card-me-screen')?.remove();
}
el('screenBtn').addEventListener('click', async () => {
  try {
    if (screenStream) { await stopScreenShare(); return; }
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: false
    });
    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = () => { void stopScreenShare(); };
    for (const [peerId, peer] of peers) {
      await peer.videoTransceiver.sender.replaceTrack(screenTrack);
      peer.videoTransceiver.direction = 'sendrecv';
      await negotiate(peerId, peer);
    }
    addCard('me-screen', `${myName} (вы)`, screenStream, true);
    el('screenBtn').classList.add('active');
  } catch (error) {
    if (error.name !== 'NotAllowedError') alert('Не удалось начать показ экрана.');
  }
});
el('leaveBtn').addEventListener('click', () => { micStream?.getTracks().forEach(t => t.stop()); screenStream?.getTracks().forEach(t => t.stop()); socket.disconnect(); location.href = '/'; });
