// ws-server.js
const WebSocket = require('ws');
const url = require('url');

let wss;

// Map of userId -> Set<WebSocket>
const clients = new Map();

/**
 * Start WebSocket server
 */
function startWebSocket(server, options = {}) {
    const path = options.path || process.env.WS_PATH || '/ws';

    // Use noServer so we can bind path & headers ourselves
    wss = new WebSocket.Server({
        noServer: true,
        clientTracking: true,
        perMessageDeflate: true,
    });

    server.on('upgrade', (req, socket, head) => {
        const { pathname } = url.parse(req.url);

        // Only allow the expected path
        if (pathname !== path) {
            socket.destroy();
            return;
        }

        // Check for secret header (no response if invalid)
        const appId = req.headers['x-app-id'];
        const allowedAppIds = (process.env.ALLOWED_APP_IDS || 'com.startlands.tcg')
            .split(',')
            .map(s => s.trim());

        if (!appId || !allowedAppIds.includes(appId)) {
            // silently drop the connection
            socket.destroy();
            return;
        }

        // If everything is fine, upgrade to WS
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws, req) => {
        const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
        console.log(`[WS] Client connected from ${remote}, url=${req.url}`);

        // Heartbeat
        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', (message) => {
            console.log(`[WS] Raw message: ${message}`);
            try {
                const data = JSON.parse(message.toString());
                if (data.userId) {
                    const set = clients.get(data.userId) || new Set();
                    set.add(ws);
                    clients.set(data.userId, set);
                    console.log(`[WS] Registered userId=${data.userId}, total clients=${set.size}`);
                }
            } catch (err) {
                console.error('[WS] Invalid message JSON', err);
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`[WS] Closed: code=${code}, reason=${reason}`)
            for (const [userId, set] of clients.entries()) {
                if (set.has(ws)) {
                    set.delete(ws);
                    if (set.size === 0) clients.delete(userId);
                    console.log(`[WS] Cleaned up userId=${userId}, remaining clients=${set.size}`);
                    break;
                }
            }
        });

        ws.on('error', (err) => {
            console.error('[WS] Socket error:', err);
        });
    });

    // Heartbeat interval
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

/**
 * Notify Unity client that a payment succeeded
 */
function notifyPaymentSuccess(userId) {
    const set = clients.get(userId);
    if (!set || set.size === 0) {
        console.log(`[WS] Tried to notify userId=${userId}, but no clients connected`);
        return false;
    }

    const payload = JSON.stringify({ eventName: 'paymentSuccess', userId });
    console.log(`[WS] Sending paymentSuccess to userId=${userId}, sockets=${set.size}`);

    for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        } else {
            console.log(`[WS] Skipped closed socket for userId=${userId}`);
        }
    }

    return true;
}

function notifyPaymentProcess(userId, url) {
    const set = clients.get(userId);
    if (!set || set.size === 0) {
        console.log(`[WS] Tried to notify userId=${userId}, but no clients connected`);
        return false;
    }

    const payload = JSON.stringify({ eventName: 'paymentProcess', userId, url });
    console.log(`[WS] Sending paymentProcess to userId=${userId}, url=${url}, sockets=${set.size}`);

    for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    }
    return true;
}

module.exports = { startWebSocket, notifyPaymentSuccess, notifyPaymentProcess };
