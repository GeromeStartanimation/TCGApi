// ws-server.js
const WebSocket = require('ws');
const url = require('url');

let wss;

// ===============================
// Data Stores
// ===============================

// Map of userId -> Set<WebSocket>
const clients = new Map();

// Map of username -> Set<WebSocket>
const clientsByUsername = new Map();

// Map of username -> status ("online", "in_game", "offline")
const userStatuses = new Map();

// Map of username -> last status timestamp
const lastStatusAt = new Map();

function startWebSocket(server, options = {}) {
    const path = options.path || process.env.WS_PATH || '/ws';

    wss = new WebSocket.Server({
        noServer: true,
        clientTracking: true,
        perMessageDeflate: true,
    });

    // ===============================
    // Handle Upgrade Requests (HTTP -> WS)
    // ===============================
    server.on('upgrade', (req, socket, head) => {
        const { pathname } = url.parse(req.url);
        if (pathname !== path) {
            socket.destroy();
            return;
        }

        // Security: check app-id header
        const appId = req.headers['x-app-id'] || req.headers['sec-websocket-protocol'];
        const allowedAppIds = (process.env.ALLOWED_APP_IDS || 'com.startlands.tcg')
            .split(',')
            .map(s => s.trim());

        if (!appId || !allowedAppIds.includes(appId)) {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    // ===============================
    // Handle WebSocket Connection
    // ===============================
    wss.on('connection', (ws, req) => {
        const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        console.log(`[WS] Client connected from ${remote}, url=${req.url}`);

        // Setup heartbeat for idle detection
        ws.isAlive = true;
        ws.on('pong', () => ws.isAlive = true);

        // ===============================
        // Handle Messages
        // ===============================
        ws.on('message', (message) => {
            console.log(`[WS] Raw message: ${message}`);
            let data;
            try {
                data = JSON.parse(message.toString());
            } catch (err) {
                console.error('[WS] Invalid message JSON', err);
                return;
            }

            // -------------------------------
            // IDENTIFY (by userId)
            // -------------------------------
            if (data.userId) {
                const set = clients.get(data.userId) || new Set();
                set.add(ws);
                clients.set(data.userId, set);
                ws.userId = data.userId;
                console.log(`[WS] Registered userId=${data.userId}, total clients=${set.size}`);
            }

            // -------------------------------
            // IDENTIFY (by username)
            // -------------------------------
            if (data.eventName === "identify" && data.username) {
                const set = clientsByUsername.get(data.username) || new Set();
                set.add(ws);
                clientsByUsername.set(data.username, set);
                ws.username = data.username;

                // Track as online
                userStatuses.set(data.username, "online");
                lastStatusAt.set(data.username, Date.now());
                console.log(`[WS] IDENTIFY -> ${data.username} STATUS=ONLINE`);

                broadcastStatusUpdate(data.username, "online", ws);
                sendStatusSnapshot(ws);
            }

            // -------------------------------
            // STATUS CHANGE (set_status)
            // -------------------------------
            if (data.eventName === "set_status" && data.username && data.status) {
                const newStatus = data.status; // "online" | "in_game" | "offline"
                userStatuses.set(data.username, newStatus);
                lastStatusAt.set(data.username, Date.now());
                console.log(`[WS] STATUS UPDATE -> ${data.username} is now ${newStatus.toUpperCase()}`);

                broadcastStatusUpdate(data.username, newStatus, null);
            }

            // -------------------------------
            // Handle INVITES (unchanged)
            // -------------------------------
            if (data.eventName === 'private_invite' ||
                data.eventName === 'private_invite_cancel' ||
                data.eventName === 'private_invite_reject' ||
                data.eventName === 'private_invite_confirm') {
                const targetSet = clientsByUsername.get(data.toUsername);
                if (targetSet) {
                    for (const client of targetSet) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    }
                }
                console.log(`[WS] Forwarded ${data.eventName} from ${data.fromUsername} to ${data.toUsername}`);
            }
        });

        // ===============================
        // Handle Close (disconnect)
        // ===============================
        ws.on('close', (code, reason) => {
            console.log(`[WS] Closed: code=${code}, reason=${reason}`);

            if (ws.userId) {
                const set = clients.get(ws.userId);
                if (set) {
                    set.delete(ws);
                    if (set.size === 0) clients.delete(ws.userId);
                }
            }

            if (ws.username) {
                const set = clientsByUsername.get(ws.username);
                if (set) {
                    set.delete(ws);
                    if (set.size === 0) {
                        clientsByUsername.delete(ws.username);
                        userStatuses.set(ws.username, "offline");
                        console.log(`[WS] DISCONNECT -> ${ws.username} OFFLINE`);
                        broadcastStatusUpdate(ws.username, "offline", null);
                    }
                }
            }
        });

        ws.on('error', (err) => console.error('[WS] Socket error:', err));
    });

    // ===============================
    // Heartbeat + Presence Sweep
    // ===============================
    const interval = setInterval(() => {
        const now = Date.now();

        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                console.log('[WS] Terminating stale client (no heartbeat)');
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }

        // Check last status timestamps (timeout = 60s)
        for (const [username, ts] of lastStatusAt.entries()) {
            if (now - ts > 60000) {
                userStatuses.set(username, "offline");
                lastStatusAt.delete(username);
                console.log(`[WS] TIMEOUT -> ${username} marked OFFLINE`);
                broadcastStatusUpdate(username, "offline", null);
            }
        }
    }, Number(process.env.WS_HEARTBEAT_SEC || 30) * 1000);

    wss.on('close', () => clearInterval(interval));

    const addr = server.address();
    let host = addr.address;
    if (host === '::' || host === '0.0.0.0') host = '0.0.0.0 (all interfaces)';
    const scheme = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
    console.log(`[WS] Server listening on ${scheme}://${host}:${addr.port}${path}`);
}

// Helpers
function broadcastStatusUpdate(username, status, excludeWs) {
    const payload = JSON.stringify({ eventName: "status_update", username, status });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            client.send(payload);
        }
    }
}

function sendStatusSnapshot(ws) {
    const entries = [];
    for (const [username, status] of userStatuses.entries()) {
        entries.push({ username, status });
    }
    const payload = JSON.stringify({ eventName: "status_snapshot", entries });
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

// Exports
function getUserStatus(username) {
    return userStatuses.get(username) || "offline";
}
function notifyPaymentSuccess(userId) { /* unchanged */ }
function notifyPaymentProcess(userId, url) { /* unchanged */ }

module.exports = { startWebSocket, notifyPaymentSuccess, notifyPaymentProcess, getUserStatus };
