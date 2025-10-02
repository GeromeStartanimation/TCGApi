// ws-server.js
// A minimal-yet-robust WebSocket server with presence tracking.
// - Detects "zombie" clients via heartbeat (default 10s)
// - Marks users offline when their last socket dies
// - Exposes notifyPaymentSuccess / notifyPaymentProcess(userId, ...) utilities
// - Supports identification via { eventName: "identify", username, userId? }
// - Optional header allowlist via X-App-Id
//
// Usage (in your HTTP server bootstrap):
//   const httpServer = require('http').createServer(app);
//   const { startWebSocket, notifyPaymentSuccess, notifyPaymentProcess } = require('./ws-server');
//   startWebSocket(httpServer, { path: '/ws' });
//   httpServer.listen(PORT);

const WebSocket = require('ws');
const url = require('url');

// ====== CONFIG ======
const WS_PATH = process.env.WS_PATH || '/ws';
const HEARTBEAT_SEC = Number(process.env.WS_HEARTBEAT_SEC || 10);
const ALLOWED_APP_IDS = (process.env.WS_ALLOWED_APP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// Example: WS_ALLOWED_APP_IDS="com.startlands.tcg,dev.local"

// ====== STATE MAPS ======
// Sockets keyed by Startlands "userId"
const clientsByUserId = new Map();     // Map<string, Set<WebSocket>>
// Sockets keyed by username (used for friends list presence)
const clientsByUsername = new Map();   // Map<string, Set<WebSocket>>
// Presence registry
const userStatuses = new Map();        // Map<string, "offline"|"online"|"in_game"|"busy"|string>

// ====== HELPERS ======
function safeAddToMapSet(map, key, value) {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(value);
    return set;
}

function safeRemoveFromMapSet(map, key, value) {
    const set = map.get(key);
    if (!set) return 0;
    set.delete(value);
    if (set.size === 0) map.delete(key);
    return set.size;
}

function socketIsOpen(ws) {
    return ws && ws.readyState === WebSocket.OPEN;
}

function broadcastStatusUpdate(username, status, excludeWs = null) {
    const payload = JSON.stringify({
        eventName: 'status_update',
        username,
        status
    });
    // Broadcast to all connected peers (simple + effective for friends lists)
    // If you want to target only friends of "username", implement a roster and filter here.
    wss.clients.forEach((client) => {
        if (client !== excludeWs && socketIsOpen(client)) {
            try { client.send(payload); } catch { }
        }
    });
}

function sendStatusSnapshot(ws) {
    // Provide a compact snapshot of all known presences on connect/identify
    const list = [];
    for (const [username, status] of userStatuses.entries()) {
        list.push({ username, status });
    }
    const payload = JSON.stringify({
        eventName: 'status_snapshot',
        users: list
    });
    try { if (socketIsOpen(ws)) ws.send(payload); } catch { }
}

// ====== PAYMENT NOTIFIERS (unchanged public API) ======
function notifyPaymentSuccess(userId) {
    const set = clientsByUserId.get(String(userId));
    if (!set || set.size === 0) {
        console.log(`[Topup/WS] No live sockets for userId=${userId} (payment_success skipped)`);
        return;
    }
    const payload = JSON.stringify({ eventName: 'payment_success' });
    for (const ws of set) {
        if (socketIsOpen(ws)) {
            try { ws.send(payload); } catch (e) { console.error('[Topup/WS] send error:', e?.message || e); }
        }
    }
    console.log(`[Topup/WS] payment_success sent to userId=${userId}`);
}

function notifyPaymentProcess(userId, url) {
    const set = clientsByUserId.get(String(userId));
    if (!set || set.size === 0) {
        console.log(`[Topup/WS] No live sockets for userId=${userId} (payment_process skipped)`);
        return;
    }
    const payload = JSON.stringify({ eventName: 'payment_process', url });
    for (const ws of set) {
        if (socketIsOpen(ws)) {
            try { ws.send(payload); } catch (e) { console.error('[Topup/WS] send error:', e?.message || e); }
        }
    }
    console.log(`[Topup/WS] payment_process sent to userId=${userId} url=${url}`);
}

// ====== SERVER ======
let wss = null;

function startWebSocket(server, options = {}) {
    const path = options.path || WS_PATH;

    wss = new WebSocket.Server({
        noServer: true,
        clientTracking: true,
        perMessageDeflate: true
    });

    // HTTP->WS upgrade gate: enforce path and optional header checks
    server.on('upgrade', (req, socket, head) => {
        const { pathname } = url.parse(req.url);
        if (pathname !== path) {
            socket.destroy();
            return;
        }

        // Optional header allowlist
        const appId = (req.headers['x-app-id'] || req.headers['X-App-Id'] || '').toString();
        if (ALLOWED_APP_IDS.length > 0 && !ALLOWED_APP_IDS.includes(appId)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            console.warn(`[WS] Blocked upgrade: invalid x-app-id="${appId}"`);
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws, req) => {
        const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        console.log(`[WS] Client connected from ${remote} url=${req.url}`);

        ws.on('message', (buf) => {
            let data = null;
            try {
                data = JSON.parse(buf.toString());
            } catch {
                console.error('[WS] Invalid JSON message');
                return;
            }

            // Legacy: allow initial payload { userId: "..." } (for payments)
            if (data.userId) {
                ws.userId = String(data.userId);
                safeAddToMapSet(clientsByUserId, ws.userId, ws);
                console.log(`[WS] Bound userId=${ws.userId} (sockets=${clientsByUserId.get(ws.userId)?.size || 0})`);
            }

            // Presence identify: { eventName: "identify", username, userId? }
            if (data.eventName === 'identify' && data.username) {
                ws.username = String(data.username);
                safeAddToMapSet(clientsByUsername, ws.username, ws);

                // (Optional) also bind userId if provided here
                if (data.userId) {
                    ws.userId = String(data.userId);
                    safeAddToMapSet(clientsByUserId, ws.userId, ws);
                }

                // Mark online + broadcast
                const prev = userStatuses.get(ws.username);
                if (prev !== 'online') {
                    userStatuses.set(ws.username, 'online');
                    broadcastStatusUpdate(ws.username, 'online', ws);
                }
                // Give the client a snapshot for its UI
                sendStatusSnapshot(ws);

                console.log(`[WS] identify username=${ws.username} userId=${ws.userId || '(n/a)'} sockets.username=${clientsByUsername.get(ws.username)?.size || 0}`);
            }

            // Manual status switch (e.g., in_game / busy / offline)
            if (data.eventName === 'set_status' && data.username && data.status) {
                const u = String(data.username);
                const s = String(data.status);
                userStatuses.set(u, s);
                broadcastStatusUpdate(u, s, null);
                console.log(`[WS] set_status username=${u} -> ${s}`);
            }

            // Example invite relay (optional; keep if you already use these names)
            // { eventName:"private_invite", toUsername, fromUsername, payload }
            if (data.eventName === 'private_invite' && data.toUsername && data.fromUsername) {
                relayToUsername(data.toUsername, {
                    eventName: 'private_invite',
                    fromUsername: data.fromUsername,
                    payload: data.payload ?? {}
                });
            }
            // { eventName:"private_invite_cancel", toUsername, fromUsername }
            if (data.eventName === 'private_invite_cancel' && data.toUsername && data.fromUsername) {
                relayToUsername(data.toUsername, {
                    eventName: 'private_invite_cancel',
                    fromUsername: data.fromUsername
                });
            }
            // { eventName:"private_invite_reject", toUsername, fromUsername }
            if (data.eventName === 'private_invite_reject' && data.toUsername && data.fromUsername) {
                relayToUsername(data.toUsername, {
                    eventName: 'private_invite_reject',
                    fromUsername: data.fromUsername
                });
            }
            // { eventName:"private_invite_confirm", toUsername, fromUsername, roomId }
            if (data.eventName === 'private_invite_confirm' && data.toUsername && data.fromUsername) {
                relayToUsername(data.toUsername, {
                    eventName: 'private_invite_confirm',
                    fromUsername: data.fromUsername,
                    roomId: data.roomId
                });
            }
        });

        // Centralized disconnect cleanup
        const handleDisconnect = (why) => {
            // Remove from userId map
            if (ws.userId) {
                safeRemoveFromMapSet(clientsByUserId, ws.userId, ws);
            }

            // Remove from username map
            if (ws.username) {
                const remaining = safeRemoveFromMapSet(clientsByUsername, ws.username, ws);
                if (remaining === 0) {
                    // Last socket for this username gone -> offline
                    if (userStatuses.get(ws.username) !== 'offline') {
                        userStatuses.set(ws.username, 'offline');
                        broadcastStatusUpdate(ws.username, 'offline', null);
                    }
                }
            }

            console.log(`[WS] Disconnected ${ws.username || '(unknown)'}: ${why}`);
        };

        ws.on('close', (code, reason) => {
            handleDisconnect(`close code=${code} reason=${reason}`);
        });

        ws.on('error', (err) => {
            console.error('[WS] Socket error:', err?.message || err);
            handleDisconnect('error');
        });
    });

    // Heartbeat + presence sweep (reap zombies + enforce offline if no sockets remain)
    const interval = setInterval(() => {
        // 1) Heartbeat sweep
        for (const ws of wss.clients) {
            if (ws.isAlive === false) {
                console.log('[WS] Terminating stale client (no heartbeat pong)');
                try { ws.terminate(); } catch { }
                continue;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch { }
        }

        // 2) Presence sweep: ensure "offline" if a username has no OPEN sockets
        for (const [username, set] of [...clientsByUsername.entries()]) {
            // remove closed sockets defensively
            for (const s of [...set]) {
                if (!socketIsOpen(s)) set.delete(s);
            }
            if (set.size === 0) {
                clientsByUsername.delete(username);
                if (userStatuses.get(username) !== 'offline') {
                    userStatuses.set(username, 'offline');
                    broadcastStatusUpdate(username, 'offline', null);
                }
            }
        }
    }, HEARTBEAT_SEC * 1000);

    wss.on('close', () => clearInterval(interval));

    const addr = server.address();
    let host = addr?.address || '0.0.0.0';
    if (host === '::' || host === '0.0.0.0') host = '0.0.0.0 (all interfaces)';
    const scheme = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
    console.log(`[WS] Server listening on ${scheme}://${host}:${addr?.port}${path}`);
}

// Relay helper for invites/messages by username
function relayToUsername(toUsername, obj) {
    const set = clientsByUsername.get(String(toUsername));
    if (!set || set.size === 0) return false;
    const payload = JSON.stringify(obj);
    let sent = 0;
    for (const ws of set) {
        if (socketIsOpen(ws)) {
            try { ws.send(payload); sent++; } catch { }
        }
    }
    return sent > 0;
}

// Optional: public query for presence (consume from HTTP if needed)
function getUserStatus(username) {
    return userStatuses.get(String(username)) || 'offline';
}

module.exports = {
    startWebSocket,
    notifyPaymentSuccess,
    notifyPaymentProcess,
    getUserStatus
};
