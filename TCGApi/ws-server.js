// ws-server.js
const WebSocket = require('ws');
const url = require('url');

let wss;

// ===============================
// Data Stores
// ===============================
const clients = new Map(); // userId -> Set<WebSocket>
const clientsByUsername = new Map(); // username -> Set<WebSocket>
const userStatuses = new Map(); // username -> "online" | "in_game" | "offline"
const lastStatusAt = new Map(); // username -> timestamp
const blockedSockets = new WeakSet(); // sockets that must be ignored after rejection

// ===============================
// Dual-login helpers
// ===============================
const DUAL_LOGIN_LOG_TAG = '[DualLogin]';

function notifyAndClose(ws, reason, code = 4001) {
    try {
        blockedSockets.add(ws);

        console.log(`[DualLogin] Initiating close: user=${ws.username || 'unknown'} reason=${reason}`);

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ eventName: 'dual_login', reason }));
            console.log(`[DualLogin] Sent dual_login to ${ws.username || 'unknown'} (${reason})`);
        }

        // Notify all other active sockets for the same user
        if (ws.username && clientsByUsername.has(ws.username)) {
            for (const client of clientsByUsername.get(ws.username)) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        eventName: 'dual_login_notice',
                        reason,
                        fromServer: true
                    }));
                    console.log(`[DualLogin] Notified active socket of ${ws.username} about ${reason}`);
                }
            }
        }
    } catch (err) {
        console.error('[DualLogin] Send failed:', err);
    }

    setTimeout(() => {
        try {
            ws.close(code, reason);
            console.log(`[DualLogin] Closed socket for ${ws.username || 'unknown'} with code=${code}`);
        } catch (e) {
            console.error('[DualLogin] Error closing socket:', e);
        }
    }, 300);
}

function enforceSecondLoginPolicy(username, newcomerWs, prevStatus) {
    const status = (prevStatus || 'offline').toLowerCase();
    const set = clientsByUsername.get(username) || new Set();

    if (status === 'in_game') {
        console.log(`${DUAL_LOGIN_LOG_TAG} [Reject] Keeping first session (${username}) because it is in_game.`);
        notifyAndClose(newcomerWs, 'in_game_active_reject_new', 4002);
        return { action: 'reject_new' };
    }

    if (status === 'online') {
        const others = Array.from(set).filter(s => s !== newcomerWs);
        if (others.length > 0) {
            console.log(`${DUAL_LOGIN_LOG_TAG} [Replace] New login for "${username}" detected. Kicking ${others.length} existing session(s).`);
            for (const old of others) notifyAndClose(old, 'replaced_by_new_login_online', 4003);
        } else {
            console.log(`${DUAL_LOGIN_LOG_TAG} [Online] No other session found for "${username}". Proceeding normally.`);
        }
        return { action: 'kick_previous' };
    }

    console.log(`${DUAL_LOGIN_LOG_TAG} [Allow] No previous session found for "${username}".`);
    return { action: 'allow' };
}

// ===============================
// Server Start
// ===============================
function startWebSocket(server, options = {}) {
    const path = options.path || process.env.WS_PATH || '/ws';

    wss = new WebSocket.Server({
        noServer: true,
        clientTracking: true,
        perMessageDeflate: true,
    });

    // Handle HTTP -> WS upgrade
    server.on('upgrade', (req, socket, head) => {
        const { pathname } = url.parse(req.url);
        if (pathname !== path) {
            socket.destroy();
            return;
        }

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

    // Connection handler
    wss.on('connection', (ws, req) => {
        const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        console.log(`[WS] Client connected from ${remote}, url=${req.url}`);

        ws.isAlive = true;
        ws.on('pong', () => ws.isAlive = true);

        ws.on('message', (message) => {
            let data;
            try {
                data = JSON.parse(message.toString());
            } catch (err) {
                console.error('[WS] Invalid message JSON', err);
                return;
            }

            if (blockedSockets.has(ws)) {
                console.log(`[WS] Ignored message from blocked socket (${ws.username || 'unknown'})`);
                return;
            }

            // Identify by userId
            if (data.userId) {
                const set = clients.get(data.userId) || new Set();
                set.add(ws);
                clients.set(data.userId, set);
                ws.userId = data.userId;
                console.log(`[WS] Registered userId=${data.userId}, total clients=${set.size}`);
            }

            // Identify by username (dual-login check)
            if (data.eventName === "identify" && data.username) {
                const username = String(data.username);
                const prevStatus = (userStatuses.get(username) || "offline").toLowerCase();
                const forceReplace = !!data.forceReplace;

                let set = clientsByUsername.get(username);
                if (!set) { set = new Set(); clientsByUsername.set(username, set); }
                set.add(ws);
                ws.username = username;

                //forceReplace logic
                if (forceReplace) {
                    const others = Array.from(set).filter(s => s !== ws);
                    if (others.length > 0) {
                        console.log(`[DualLogin] [ForceReplace] ${username} requested replacement. Kicking ${others.length} session(s).`);
                        for (const old of others) notifyAndClose(old, 'replaced_by_new_login_online', 4003);
                    }
                }

                const action = enforceSecondLoginPolicy(username, ws, prevStatus);
                if (action.action === 'reject_new') {
                    set.delete(ws);
                    if (set.size === 0) clientsByUsername.delete(username);
                    return;
                }

                // Preserve "in_game" status
                const prev = userStatuses.get(username);
                if (!prev || prev === "offline") {
                    userStatuses.set(username, "online");
                    console.log(`[WS] IDENTIFY -> ${username} STATUS=ONLINE`);
                } else {
                    console.log(`[WS] IDENTIFY -> ${username} (kept previous status: ${prev})`);
                }

                lastStatusAt.set(username, Date.now());
                broadcastStatusUpdate(username, userStatuses.get(username), ws);
                sendStatusSnapshot(ws);
            }

            // Status change
            if (data.eventName === "set_status" && data.username && data.status) {
                if (blockedSockets.has(ws)) {
                    console.log(`[WS] Ignored set_status from blocked socket (${data.username})`);
                    return;
                }

                const newStatus = data.status;
                userStatuses.set(data.username, newStatus);
                lastStatusAt.set(data.username, Date.now());
                console.log(`[WS] STATUS UPDATE -> ${data.username} is now ${newStatus.toUpperCase()}`);
                broadcastStatusUpdate(data.username, newStatus, null);
            }

            // Invitation forwarding
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

        // Close handler
        ws.on('close', (code, reason) => {
            console.log(`[WS] Closed: code=${code}, reason=${reason}`);
            blockedSockets.delete(ws);

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

    // Heartbeat and timeout sweep
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

        // Timeout inactive users after 60s
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

// ===============================
// Helper functions
// ===============================
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

function getUserStatus(username) {
    return userStatuses.get(username) || "offline";
}

// Placeholder notifications
function notifyPaymentSuccess(userId) { }
function notifyPaymentProcess(userId, url) { }

// Export
module.exports = { startWebSocket, notifyPaymentSuccess, notifyPaymentProcess, getUserStatus };
