
/*
 * rpc4SoundCloud Enhanced — Vencord plugin
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

interface NowPlaying {
    title: string | null;
    artist: string | null;
    artworkUrl: string | null;
    playing: boolean;
    buffering: boolean;
    positionSeconds: number | null;
    durationSeconds: number | null;
    url: string;
}

interface RelayMessage {
    type: "presence";
    payload: NowPlaying | null;
}

export const settings = definePluginSettings({
    relayPort: {
        type: OptionType.NUMBER,
        description: "Port the local rpc4SoundCloud relay server is listening on",
        default: 6989,
    },
    appId: {
        type: OptionType.STRING,
        description: "Discord Application ID (from the Developer Portal). Required for artwork to render.",
        default: "",
    },
});

let socket: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let activityRequestId = 0;
let running = false;

const artworkCache = new Map<string, string | undefined>();

function validPayload(data: unknown): data is NowPlaying {
    if (!data || typeof data !== "object") return false;

    const value = data as Record<string, unknown>;

    if (
        typeof value.playing !== "boolean" ||
        typeof value.buffering !== "boolean" ||
        typeof value.url !== "string"
    ) return false;

    for (const key of ["title", "artist", "artworkUrl"]) {
        if (value[key] !== null && typeof value[key] !== "string")
            return false;
    }

    for (const key of ["positionSeconds", "durationSeconds"]) {
        if (
            value[key] !== null &&
            (typeof value[key] !== "number" ||
                !Number.isFinite(value[key]) ||
                (value[key] as number) < 0)
        ) return false;
    }

    return true;
}

async function resolveArtwork(
    appId: string,
    url: string
): Promise<string | undefined> {
    const key = `${appId}:${url}`;

    if (artworkCache.has(key))
        return artworkCache.get(key);

    try {
        const [assetId] = await ApplicationAssetUtils.fetchAssetIds(appId, [url]);
        artworkCache.set(key, assetId);
        return assetId;
    } catch (error) {
        console.error("[rpc4SoundCloud] artwork resolution failed", error);
        return undefined;
    }
}

async function buildActivity(data: NowPlaying): Promise<Activity | undefined> {
    if (!data.title || !data.playing || data.buffering)
        return undefined;

    const title = data.title.trim();
    const artist = data.artist?.trim();

    if (!title) return undefined;

    const appId = settings.store.appId || "0";

    const activity: Activity = {
        application_id: appId,
        name: "SoundCloud",
        details: title,
        state: artist && artist.toLowerCase() !== title.toLowerCase()
            ? artist
            : undefined,
        type: ActivityType.LISTENING,
        flags: 1 << 0,
    };

    if (data.positionSeconds !== null) {
        const start = Date.now() - data.positionSeconds * 1000;
        activity.timestamps = { start };

        if (
            data.durationSeconds !== null &&
            data.durationSeconds > data.positionSeconds
        ) {
            activity.timestamps.end =
                start + data.durationSeconds * 1000;
        }
    }

    if (data.artworkUrl && settings.store.appId) {
        const assetId = await resolveArtwork(appId, data.artworkUrl);

        if (assetId) {
            activity.assets = { large_image: assetId };
        }
    }

    return activity;
}

function pushActivity(activity: Activity | undefined) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: activity ?? null,
        socketId: "rpc4SoundCloud",
    });
}

function scheduleReconnect() {
    if (!running || reconnectTimeout !== null) return;

    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connect();
    }, 3000);
}

function connect() {
    if (!running) return;

    if (
        socket?.readyState === WebSocket.OPEN ||
        socket?.readyState === WebSocket.CONNECTING
    ) return;

    const port = settings.store.relayPort || 6989;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    socket = ws;

    ws.onopen = () => {
        if (!running) {
            ws.close();
            return;
        }

        console.log("[rpc4SoundCloud] connected to relay");

        ws.send(JSON.stringify({
            type: "hello",
            role: "plugin",
        }));
    };

    ws.onmessage = async event => {
        try {
            const message: RelayMessage = JSON.parse(event.data);

            if (message?.type !== "presence") return;

            if (message.payload !== null && !validPayload(message.payload)) {
                console.warn("[rpc4SoundCloud] rejected invalid payload");
                return;
            }

            const requestId = ++activityRequestId;

            const activity = message.payload
                ? await buildActivity(message.payload)
                : undefined;

            if (running && requestId === activityRequestId)
                pushActivity(activity);
        } catch (error) {
            console.error("[rpc4SoundCloud] invalid relay message", error);
        }
    };

    ws.onclose = () => {
        if (socket === ws)
            socket = null;

        activityRequestId++;
        pushActivity(undefined);

        if (running)
            scheduleReconnect();
    };

    ws.onerror = () => ws.close();
}

function disconnect() {
    running = false;
    activityRequestId++;

    if (reconnectTimeout !== null) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    const oldSocket = socket;
    socket = null;

    oldSocket?.close();
    pushActivity(undefined);
}

export default definePlugin({
    name: "rpc4SoundCloud Enhanced",
    description: "Shows what you're listening to on SoundCloud as a Discord Rich Presence, fed live from a browser extension.",
    authors: [{ name: "you", id: 0n }],
    settings,

    start() {
        running = true;
        connect();
    },

    stop() {
        disconnect();
    },
});
