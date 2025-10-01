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
        const appId = req.headers['x-app-id'];
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
                console.log(`[WS] IDENTIFY -> ${data.username} logged in, STATUS=ONLINE, total clients=${set.size}`);

                // Broadcast to everyone else that this user is online
                broadcastStatusUpdate(data.username, "online", ws);

                // Send a snapshot of all known statuses to THIS client
                sendStatusSnapshot(ws);
            }

            // -------------------------------
            // STATUS CHANGE (set_status)
            // -------------------------------
            if (data.eventName === "set_status" && data.username && data.status) {
                const newStatus = data.status; // "online" | "in_game" | "offline"
                userStatuses.set(data.username, newStatus);
                console.log(`[WS] STATUS UPDATE -> ${data.username} is now ${newStatus.toUpperCase()}`);

                // Broadcast to all clients
                broadcastStatusUpdate(data.username, newStatus, null);
            }

            // -------------------------------
            // Handle PRIVATE INVITE
            // -------------------------------
            if (data.eventName === 'private_invite') {
                const targetSet = clientsByUsername.get(data.toUsername);
                if (targetSet && targetSet.size > 0) {
                    for (const client of targetSet) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    }
                    console.log(`[WS] Forwarded invite from ${data.fromUsername} to ${data.toUsername}`);
                } else {
                    console.log(`[WS] Target not connected: ${data.toUsername}`);
                }
            }

            // -------------------------------
            // Handle CANCEL
            // -------------------------------
            if (data.eventName === "private_invite_cancel") {
                const targetSet = clientsByUsername.get(data.toUsername);
                if (targetSet) {
                    for (const client of targetSet) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    }
                }
                console.log(`[WS] Invite canceled by ${data.fromUsername} for ${data.toUsername}`);
            }

            // -------------------------------
            // Handle REJECT
            // -------------------------------
            if (data.eventName === "private_invite_reject") {
                const targetSet = clientsByUsername.get(data.toUsername);
                if (targetSet) {
                    for (const client of targetSet) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    }
                }
                console.log(`[WS] Invite rejected by ${data.fromUsername} to ${data.toUsername}`);
            }

            // -------------------------------
            // Handle CONFIRM
            // -------------------------------
            if (data.eventName === "private_invite_confirm") {
                const targetSet = clientsByUsername.get(data.toUsername);
                if (targetSet) {
                    for (const client of targetSet) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    }
                }
                console.log(`[WS] Invite confirmed between ${data.fromUsername} and ${data.toUsername}`);
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
