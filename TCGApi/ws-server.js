// ws-server.js
const WebSocket = require('ws');
const url = require('url');

let wss;

// Map of userId -> Set<WebSocket>
const clients = new Map();
// Map of username -> Set<WebSocket>
const clientsByUsername = new Map();

function startWebSocket(server, options = {}) {
    const path = options.path || process.env.WS_PATH || '/ws';

    wss = new WebSocket.Server({
        noServer: true,
        clientTracking: true,
        perMessageDeflate: true,
    });

    server.on('upgrade', (req, socket, head) => {
        const { pathname } = url.parse(req.url);
        if (pathname !== path) {
            socket.destroy();
            return;
        }

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

    wss.on('connection', (ws, req) => {
        const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        console.log(`[WS] Client connected from ${remote}, url=${req.url}`);

        ws.isAlive = true;
        ws.on('pong', () => ws.isAlive = true);

        ws.on('message', (message) => {
            console.log(`[WS] Raw message: ${message}`);
            try {
                const data = JSON.parse(message.toString());

                // Handle IDENTIFY by userId
                if (data.userId) {
                    const set = clients.get(data.userId) || new Set();
                    set.add(ws);
                    clients.set(data.userId, set);
                    ws.userId = data.userId;
                    console.log(`[WS] Registered userId=${data.userId}, total clients=${set.size}`);
                }

                // Handle IDENTIFY by username (for invites)
                if (data.username && !data.eventName) {
                    const set = clientsByUsername.get(data.username) || new Set();
                    set.add(ws);
                    clientsByUsername.set(data.username, set);
                    ws.username = data.username;
                    console.log(`[WS] Registered username=${data.username}, total clients=${set.size}`);
                }

                // Handle private_invite
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

                // Handle IDENTIFY by username (for invites)
                if (data.eventName === "identify" && data.username) {
                    const set = clientsByUsername.get(data.username) || new Set();
                    set.add(ws);
                    clientsByUsername.set(data.username, set);
                    ws.username = data.username;
                    console.log(`[WS] Registered username=${data.username}, total clients=${set.size}`);
                }

            } catch (err) {
                console.error('[WS] Invalid message JSON', err);
            }
        });

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
                    if (set.size === 0) clientsByUsername.delete(ws.username);
                }
            }
        });

        ws.on('error', (err) => console.error('[WS] Socket error:', err));
    });

    // Heartbeat
    const interval = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                console.log('[WS] Terminating stale client');
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, Number(process.env.WS_HEARTBEAT_SEC || 30) * 1000);

    wss.on('close', () => clearInterval(interval));

    const addr = server.address();
    let host = addr.address;
    if (host === '::' || host === '0.0.0.0') host = '0.0.0.0 (all interfaces)';
    const scheme = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
    console.log(`[WS] Server listening on ${scheme}://${host}:${addr.port}${path}`);
}

// Existing payment functions stay the same
function notifyPaymentSuccess(userId) { /* unchanged */ }
function notifyPaymentProcess(userId, url) { /* unchanged */ }

module.exports = { startWebSocket, notifyPaymentSuccess, notifyPaymentProcess };
