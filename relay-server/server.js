
// rpc4SoundCloud Enhanced — validated, tab-aware WebSocket relay

const { WebSocketServer, WebSocket } = require("ws");

const HOST = "127.0.0.1";
const PORT = 6989;
const MAX_PAYLOAD = 16 * 1024;

const wss = new WebSocketServer({
    host: HOST,
    port: PORT,
    maxPayload: MAX_PAYLOAD,
});

const clients = new Set();
const tabs = new Map();

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function validPlayback(data) {
    if (!data || typeof data !== "object" || Array.isArray(data))
        return false;

    if (
        typeof data.playing !== "boolean" ||
        typeof data.buffering !== "boolean" ||
        typeof data.url !== "string" ||
        data.url.length > 2048
    ) return false;

    for (const key of ["title", "artist", "artworkUrl"]) {
        if (data[key] !== null && typeof data[key] !== "string")
            return false;
        if (typeof data[key] === "string" && data[key].length > 4096)
            return false;
    }

    for (const key of ["positionSeconds", "durationSeconds"]) {
        if (
            data[key] !== null &&
            (typeof data[key] !== "number" ||
                !Number.isFinite(data[key]) ||
                data[key] < 0)
        ) return false;
    }

    return true;
}

function getActivePresence() {
    let selected = null;

    for (const entry of tabs.values()) {
        const data = entry.payload;

        if (!data || !data.playing || data.buffering)
            continue;

        if (!selected || entry.updatedAt > selected.updatedAt)
            selected = entry;
    }

    return selected?.payload ?? null;
}

function publishPresence() {
    const message = {
        type: "presence",
        payload: getActivePresence(),
    };

    for (const client of clients) {
        if (client.role === "plugin")
            send(client.socket, message);
    }
}

wss.on("connection", socket => {
    const client = {
        socket,
        role: null,
        tabId: null,
    };

    clients.add(client);

    console.log(`[relay] client connected (${clients.size} total)`);

    socket.on("message", raw => {
        let message;

        try {
            message = JSON.parse(raw.toString());
        } catch {
            console.warn("[relay] rejected invalid JSON");
            return;
        }

        if (!message || typeof message !== "object" || Array.isArray(message))
            return;

        // Every client must identify itself first.
        if (client.role === null) {
            if (message.type === "hello" && message.role === "plugin") {
                client.role = "plugin";
                send(socket, {
                    type: "presence",
                    payload: getActivePresence(),
                });
                return;
            }

            if (
                message.type === "hello" &&
                message.role === "extension" &&
                typeof message.tabId === "string" &&
                /^[a-zA-Z0-9_-]{1,100}$/.test(message.tabId)
            ) {
                client.role = "extension";
                client.tabId = message.tabId;

                // A new connection replaces an older connection for
                // the same tab, without clearing unrelated tabs.
                tabs.set(client.tabId, {
                    payload: null,
                    updatedAt: Date.now(),
                });

                publishPresence();
                return;
            }

            socket.close(1008, "Identify as plugin or extension first");
            return;
        }

        if (client.role !== "extension")
            return;

        if (message.type === "stop") {
            tabs.delete(client.tabId);
            publishPresence();
            return;
        }

        if (message.type !== "presence" || !validPlayback(message.payload)) {
            console.warn("[relay] rejected invalid presence payload");
            return;
        }

        tabs.set(client.tabId, {
            payload: message.payload,
            updatedAt: Date.now(),
        });

        publishPresence();
    });

    socket.on("close", () => {
        clients.delete(client);

        if (client.role === "extension" && client.tabId) {
            tabs.delete(client.tabId);
            publishPresence();
        }

        console.log(`[relay] client disconnected (${clients.size} total)`);
    });

    socket.on("error", error => {
        console.error("[relay] WebSocket error:", error.message);
    });
});

console.log(`[relay] listening on ws://${HOST}:${PORT}`);
