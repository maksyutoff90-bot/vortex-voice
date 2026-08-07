const socket = io();
const roomId = new URLSearchParams(location.search).get('room') || crypto.randomUUID().slice(0, 8);
if (!location.search.includes('room=')) history.replaceState({}, '', `?room=${roomId}`);

const peers = new Map();
let myName = '';
let micStream;
let screenStream;
let muted = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const el = (id) => document.getElementById(id);

el('channelTitle').textContent = `Комната #${roomId}`;
el('roomLabel').textContent = `# ${roomId}`;
const dialog = el('joinDialog');
dialog.showModal();

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
  if (stream) { const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.srcObject = stream; card.append(v); }
  else { const avatar = document.createElement('div'); avatar.className = 'avatar-stage'; avatar.textContent = initials(name); card.append(avatar); }
  if (screen) { const tag = document.createElement('span'); tag.className = 'screen-tag'; tag.textContent = `${name} показывает экран`; card.append(tag); }
  const label = document.createElement('span'); label.className = 'participant-name'; label.textContent = name; card.append(label); el('stage').append(card);
}
async function createPeer(peerId, name, makeOffer) {
  if (peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, name, screenTrackId: null };
  peers.set(peerId, peer); updateMembers();
  micStream?.getTracks().forEach(t => pc.addTrack(t, micStream));
  if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
  pc.onicecandidate = ({ candidate }) => candidate && socket.emit('signal', { to: peerId, data: { candidate } });
  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: peerId, data: { description: pc.localDescription } });
    } catch (error) { console.warn('Negotiation error', error); }
  };
  pc.ontrack = ({ streams, track }) => {
    const stream = streams[0];
    const isScreen = track.kind === 'video';
    addCard(`${peerId}-${isScreen ? 'screen' : 'audio'}`, name, isScreen ? stream : null, isScreen);
  };
  pc.onconnectionstatechange = () => { if (['failed','closed'].includes(pc.connectionState)) removePeer(peerId); };
  if (makeOffer) { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('signal', { to: peerId, data: { description: pc.localDescription } }); }
  return peer;
}
function removePeer(id) { const peer = peers.get(id); peer?.pc.close(); peers.delete(id); document.getElementById(`card-${id}-audio`)?.remove(); document.getElementById(`card-${id}-screen`)?.remove(); updateMembers(); }
async function getMicrophone() { try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); } catch { alert('Не удалось получить доступ к микрофону. Проверьте разрешение в браузере.'); } }
socket.on('room-peers', async list => { for (const p of list) await createPeer(p.id, p.name, true); });
socket.on('peer-joined', ({ id, name }) => { createPeer(id, name, false); });
socket.on('peer-left', ({ id }) => removePeer(id));
socket.on('signal', async ({ from, data }) => {
  let peer = peers.get(from);
  if (!peer) peer = await createPeer(from, 'Гость', false);
  try { if (data.description) { await peer.pc.setRemoteDescription(data.description); if (data.description.type === 'offer') { const answer = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(answer); socket.emit('signal', { to: from, data: { description: peer.pc.localDescription } }); } } else if (data.candidate) await peer.pc.addIceCandidate(data.candidate); } catch (error) { console.error('WebRTC signal error', error); }
});
socket.on('connect', () => { el('connectionText').textContent = 'В голосовом канале'; });
socket.on('disconnect', () => { el('connectionText').textContent = 'Переподключение…'; });

el('joinForm').addEventListener('submit', async (e) => { e.preventDefault(); myName = el('nameInput').value.trim(); if (!myName) return; await iceConfigReady; el('meName').textContent = myName; await getMicrophone(); socket.emit('join-room', { roomId, name: myName }); dialog.close(); addCard('me-audio', `${myName} (вы)`, null); updateMembers(); });
el('micBtn').addEventListener('click', () => { if (!micStream) return; muted = !muted; micStream.getAudioTracks().forEach(t => t.enabled = !muted); el('micBtn').classList.toggle('off', muted); el('micBtn').textContent = muted ? '🔇' : '🎙'; });
el('shareLink').addEventListener('click', async () => { await navigator.clipboard.writeText(location.href); const b = el('shareLink'); const old = b.textContent; b.textContent = 'Ссылка скопирована'; setTimeout(() => b.textContent = old, 1800); });
function stopScreenShare() {
  if (!screenStream) return;
  const tracks = screenStream.getTracks();
  for (const [, peer] of peers) peer.pc.getSenders().filter(sender => tracks.includes(sender.track)).forEach(sender => peer.pc.removeTrack(sender));
  tracks.forEach(track => track.stop());
  screenStream = null; el('screenBtn').classList.remove('active'); document.getElementById('card-me-screen')?.remove();
}
el('screenBtn').addEventListener('click', async () => { try { if (screenStream) { stopScreenShare(); return; } screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }, audio: true }); screenStream.getVideoTracks()[0].onended = stopScreenShare; for (const [, peer] of peers) screenStream.getTracks().forEach(track => peer.pc.addTrack(track, screenStream)); addCard('me-screen', `${myName} (вы)`, screenStream, true); el('screenBtn').classList.add('active'); } catch (error) { if (error.name !== 'NotAllowedError') alert('Не удалось начать показ экрана.'); } });
el('leaveBtn').addEventListener('click', () => { micStream?.getTracks().forEach(t => t.stop()); screenStream?.getTracks().forEach(t => t.stop()); socket.disconnect(); location.href = '/'; });
