const WebSocket = require('ws');

let wss;
const clients = new Map(); // userId -> ws

function startWebSocket(server) {
    wss = new WebSocket.Server({ server });

    wss.on('connection', (ws, req) => {
        console.log("WebSocket client connected from", req.socket.remoteAddress, ":", req.socket.remotePort);

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.userId) {
                    clients.set(data.userId, ws);
                    console.log(`Registered WebSocket for user ${data.userId}`);
                }
            } catch (err) {
                console.error("Invalid message", err);
            }
        });

        ws.on('close', () => {
            for (const [userId, socket] of clients.entries()) {
                if (socket === ws) {
                    clients.delete(userId);
                    console.log(`WebSocket for ${userId} disconnected`);
                }
            }
        });
    });

    // log host and port
    const addr = server.address();
    const host = addr.address === '::' ? 'localhost' : addr.address;
    console.log(`WebSocket server initialized on ws://${host}:${addr.port}`);
}

function notifyPaymentSuccess(userId) {
    const ws = clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ eventName: "paymentSuccess", userId }));
        console.log(`Sent paymentSuccess to ${userId}`);
    }
}

module.exports = { startWebSocket, notifyPaymentSuccess };
