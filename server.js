const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");

const publicRoot = path.resolve(__dirname);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png"
};
const allowedTopLevel = new Set(["index.html", "styles.css", "app.js", "assets"]);
const countries = new Set(["sa", "eg", "ma", "ae", "jo", "other"]);
const genders = new Set(["women", "men", "other"]);
const lookingForValues = new Set(["everyone", "women", "men"]);
const clients = new Map();
const waitingQueue = [];

function secureHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(self), microphone=(self), fullscreen=(self)");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; base-uri 'self'; frame-ancestors 'none'");
}

const server = http.createServer(async (request, response) => {
  secureHeaders(response);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const relativePath = pathname.replace(/^[/\\]+/, "");
  const topLevel = relativePath.split(/[\\/]/, 1)[0];
  if (!allowedTopLevel.has(topLevel)) {
    response.writeHead(404).end("Not found");
    return;
  }

  const filePath = path.resolve(publicRoot, relativePath);
  const relativeToRoot = path.relative(publicRoot, filePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

const webSocketServer = new WebSocketServer({ server, path: "/signal", maxPayload: 96 * 1024 });

function send(client, payload) {
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function broadcastOnlineCount() {
  const count = webSocketServer.clients.size;
  for (const client of webSocketServer.clients) send(client, { type: "online_count", count });
}

function removeFromQueue(client) {
  const index = waitingQueue.indexOf(client);
  if (index !== -1) waitingQueue.splice(index, 1);
  const state = clients.get(client);
  if (state) state.waiting = false;
}

function normalizePreferences(input = {}) {
  return {
    country: countries.has(input.country) ? input.country : "other",
    gender: genders.has(input.gender) ? input.gender : "other",
    lookingFor: lookingForValues.has(input.lookingFor) ? input.lookingFor : "everyone"
  };
}

function acceptsGender(lookingFor, gender) {
  return lookingFor === "everyone" || lookingFor === gender;
}

function compatible(first, second) {
  return acceptsGender(first.preferences.lookingFor, second.preferences.gender)
    && acceptsGender(second.preferences.lookingFor, first.preferences.gender);
}

function publicProfile(state) {
  return { country: state.preferences.country, gender: state.preferences.gender };
}

function queueClient(client) {
  const state = clients.get(client);
  if (!state || client.readyState !== WebSocket.OPEN || state.partner) return;
  removeFromQueue(client);
  state.waiting = true;

  const matchIndex = waitingQueue.findIndex((candidate) => {
    const candidateState = clients.get(candidate);
    return candidateState
      && candidate !== client
      && candidate.readyState === WebSocket.OPEN
      && !candidateState.partner
      && compatible(state, candidateState)
      && state.skipPeerId !== candidateState.id
      && candidateState.skipPeerId !== state.id;
  });

  if (matchIndex === -1) {
    waitingQueue.push(client);
    send(client, { type: "waiting" });
    return;
  }

  const peer = waitingQueue.splice(matchIndex, 1)[0];
  const peerState = clients.get(peer);
  state.waiting = false;
  peerState.waiting = false;
  state.partner = peer;
  peerState.partner = client;
  state.skipPeerId = null;
  peerState.skipPeerId = null;
  send(client, { type: "matched", initiator: true, peer: publicProfile(peerState) });
  send(peer, { type: "matched", initiator: false, peer: publicProfile(state) });
}

function detachPeer(client, { notify = true, requeuePeer = false, skipPeer = false } = {}) {
  const state = clients.get(client);
  const peer = state?.partner;
  if (!peer) return null;
  const peerState = clients.get(peer);
  state.partner = null;
  if (peerState) peerState.partner = null;
  if (skipPeer && peerState) {
    state.skipPeerId = peerState.id;
    peerState.skipPeerId = state.id;
  }
  if (notify) send(peer, { type: "peer_left" });
  if (requeuePeer && peerState && peer.readyState === WebSocket.OPEN) queueClient(peer);
  return peer;
}

function sendError(client, message) {
  send(client, { type: "error", message });
}

function relaySignal(client, message) {
  const state = clients.get(client);
  if (!state?.partner || !message.data || typeof message.data !== "object") return;
  if (message.kind === "offer" || message.kind === "answer") {
    const { type, sdp } = message.data;
    if (type !== message.kind || typeof sdp !== "string" || sdp.length > 80_000) return;
    send(state.partner, { type: "signal", kind: message.kind, data: { type, sdp } });
  } else if (message.kind === "candidate") {
    const candidate = message.data;
    if (typeof candidate.candidate !== "string" || candidate.candidate.length > 8_000) return;
    send(state.partner, { type: "signal", kind: "candidate", data: candidate });
  }
}

function handleMessage(client, message) {
  const state = clients.get(client);
  if (!state || !message || typeof message.type !== "string") return;

  if (message.type === "join") {
    if (state.partner) detachPeer(client, { requeuePeer: true, skipPeer: true });
    removeFromQueue(client);
    state.preferences = normalizePreferences(message.preferences);
    state.skipPeerId = null;
    queueClient(client);
  } else if (message.type === "next") {
    if (state.partner) detachPeer(client, { requeuePeer: true, skipPeer: true });
    else removeFromQueue(client);
    queueClient(client);
  } else if (message.type === "leave") {
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
  } else if (message.type === "signal") {
    relaySignal(client, message);
  } else if (message.type === "chat") {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const now = Date.now();
    state.messageTimes = state.messageTimes.filter((sentAt) => now - sentAt < 10_000);
    if (text.length === 0 || text.length > 500) return;
    if (state.messageTimes.length >= 12) {
      sendError(client, "تم الإرسال بسرعة. انتظر قليلًا ثم أعد المحاولة.");
      return;
    }
    if (!state.partner) return;
    state.messageTimes.push(now);
    send(state.partner, { type: "chat", text });
  } else if (message.type === "report") {
    if (!state.partner) return;
    const peer = state.partner;
    console.warn(`[report] session=${state.id} reason=${String(message.reason || "unspecified").slice(0, 80)}`);
    send(client, { type: "report_received" });
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
    if (peer.readyState === WebSocket.OPEN) queueClient(peer);
  }
}

webSocketServer.on("connection", (client, request) => {
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        client.close(1008, "Origin not allowed");
        return;
      }
    } catch {
      client.close(1008, "Invalid origin");
      return;
    }
  }

  clients.set(client, {
    id: randomUUID(),
    preferences: normalizePreferences(),
    partner: null,
    waiting: false,
    skipPeerId: null,
    messageTimes: []
  });
  broadcastOnlineCount();
  client.on("message", (raw) => {
    try {
      handleMessage(client, JSON.parse(raw.toString()));
    } catch {
      sendError(client, "تعذر قراءة الطلب.");
    }
  });
  client.on("close", () => {
    removeFromQueue(client);
    detachPeer(client, { requeuePeer: true, skipPeer: true });
    clients.delete(client);
    broadcastOnlineCount();
  });
  client.on("error", () => {});
});

const port = Number(process.env.PORT) || 3001;
server.listen(port, "0.0.0.0", () => {
  console.log(`WASL server listening on http://localhost:${port}`);
});
