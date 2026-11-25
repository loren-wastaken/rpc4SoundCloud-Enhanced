
// rpc4SoundCloud Enhanced — content.js

const RELAY_URL = "ws://127.0.0.1:6989";
const POLL_INTERVAL_MS = 1000;
const TAB_ID = crypto.randomUUID();

let socket = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let pollTimer = null;
let lastPayload = null;
let lastPosition = null;
let stuckCounter = 0;
let lastUrl = location.href;
let wasPlaying = false;
let stopped = false;
let lastPositionChange = Date.now();

function send(message) {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return true;
    }
    return false;
}

function clearPresence() {
    lastPayload = null;
    send({ type: "presence", payload: null });
}

function connect() {
    if (stopped || socket?.readyState === WebSocket.OPEN ||
        socket?.readyState === WebSocket.CONNECTING) return;

    socket = new WebSocket(RELAY_URL);

    socket.addEventListener("open", () => {
        if (stopped) {
            socket?.close();
            return;
        }

        console.log("[rpc4SoundCloud] connected to relay");
        reconnectDelay = 1000;
        lastPayload = null;
        lastPosition = null;
        stuckCounter = 0;
        lastPositionChange = Date.now();

        send({
            type: "hello",
            role: "extension",
            tabId: TAB_ID
        });

        tick();
    });

    socket.addEventListener("close", () => {
        if (socket?.readyState !== WebSocket.CLOSED) return;
        scheduleReconnect();
    });

    socket.addEventListener("error", () => {
        socket?.close();
    });
}

function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, reconnectDelay);

    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function readNowPlaying() {
    const ms = navigator.mediaSession;
    if (!ms?.metadata) {
        wasPlaying = false;
        return null;
    }

    const { title, artist, artwork } = ms.metadata;

    const artworkUrl = Array.isArray(artwork) && artwork.length
        ? artwork[artwork.length - 1]?.src ?? null
        : null;

    const timeline = document.querySelector(
        ".playbackTimeline__progressWrapper"
    );

    let positionSeconds = null;
    let durationSeconds = null;

    if (timeline) {
        const pos = Number(timeline.getAttribute("aria-valuenow"));
        const dur = Number(timeline.getAttribute("aria-valuemax"));

        if (Number.isFinite(pos) && pos >= 0)
            positionSeconds = pos;

        if (Number.isFinite(dur) && dur > 0)
            durationSeconds = dur;
    }

    const isPlaying = ms.playbackState === "playing";

    if (!isPlaying) {
        wasPlaying = false;
        lastPosition = null;
        stuckCounter = 0;
        return null;
    }

    wasPlaying = true;

    let buffering = false;

    if (positionSeconds !== null) {
        if (lastPosition === null || positionSeconds !== lastPosition) {
            lastPosition = positionSeconds;
            lastPositionChange = Date.now();
            stuckCounter = 0;
        } else {
            stuckCounter++;

            // Allow startup, seeking and short timeline updates.
            // Only consider it stalled after several seconds.
            if (stuckCounter >= 5 &&
                Date.now() - lastPositionChange >= 5000) {
                buffering = true;
            }
        }
    } else {
        lastPosition = null;
        stuckCounter = 0;
    }

    return {
        title: typeof title === "string" ? title.trim() || null : null,
        artist: typeof artist === "string" ? artist.trim() || null : null,
        artworkUrl,
        playing: true,
        buffering,
        positionSeconds,
        durationSeconds,
        url: location.href
    };
}

function tick() {
    if (stopped) return;

    if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastPayload = null;
        lastPosition = null;
        stuckCounter = 0;
        lastPositionChange = Date.now();
    }

    const payload = readNowPlaying();

    if (!payload) {
        if (lastPayload !== null) {
            clearPresence();
        }
        return;
    }

    const serialized = JSON.stringify(payload);

    if (serialized !== lastPayload) {
        lastPayload = serialized;

        send({
            type: "presence",
            payload
        });
    }
}

function shutdown() {
    if (stopped) return;
    stopped = true;

    if (pollTimer !== null)
        clearInterval(pollTimer);

    if (reconnectTimer !== null)
        clearTimeout(reconnectTimer);

    send({ type: "stop" });

    socket?.close();
    socket = null;
}

window.addEventListener("pagehide", shutdown);
window.addEventListener("beforeunload", shutdown);

connect();
pollTimer = setInterval(tick, POLL_INTERVAL_MS);
