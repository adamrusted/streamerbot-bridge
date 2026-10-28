/*
 * sb-bridge Firebot startup script.
 *
 * Forwards every Firebot event to sb-bridge, which re-emits it to Streamer.bot
 * WebSocket clients. Also adds a "Streamer.bot Bridge: Broadcast Custom Event"
 * effect that sends a General.Custom event.
 *
 * Install: Firebot → Settings → Scripts → Manage Startup Scripts → Add New Script,
 * pick this file, and set the bridge URL if it isn't http://127.0.0.1:8080.
 */
const http = require("http");
const https = require("https");

const EFFECT_ID = "sb-bridge:broadcast-custom";

let restoreTriggerEvent = null;
let settings = { bridgeUrl: "http://127.0.0.1:8080", token: "", forwardManual: true };
let logger = console;

/** JSON.stringify that drops functions and circular references. */
function safeStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, val) => {
        if (typeof val === "function") return undefined;
        if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return undefined;
            seen.add(val);
        }
        return val;
    });
}

function post(path, payload) {
    let url;
    try {
        url = new URL(path, settings.bridgeUrl);
    } catch (err) {
        logger.error(`[sb-bridge] invalid bridge URL "${settings.bridgeUrl}"`);
        return;
    }
    const body = safeStringify(payload);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...(settings.token ? { "x-bridge-token": settings.token } : {})
        },
        timeout: 3000
    }, (res) => {
        res.resume();
        if (res.statusCode >= 400) logger.warn(`[sb-bridge] ${path} -> HTTP ${res.statusCode}`);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => logger.debug(`[sb-bridge] ${path} failed: ${err.message}`));
    req.end(body);
}

function getScriptManifest() {
    return {
        name: "Streamer.bot Bridge",
        description: "Forwards Firebot events to sb-bridge so Streamer.bot WebSocket tools work with Firebot.",
        author: "sb-bridge",
        version: "0.1.0",
        firebotVersion: "5",
        startupOnly: true
    };
}

function getDefaultParameters() {
    return {
        bridgeUrl: {
            type: "string",
            default: "http://127.0.0.1:8080",
            description: "sb-bridge URL",
            secondaryDescription: "Where sb-bridge is listening (its WebSocket port)."
        },
        token: {
            type: "string",
            default: "",
            description: "Ingest token",
            secondaryDescription: "Only needed if ingestToken is set in sb-bridge.config.json."
        },
        forwardManual: {
            type: "boolean",
            default: true,
            description: "Forward manually triggered / simulated events",
            secondaryDescription: "Handy for testing overlays with Firebot's event simulator."
        }
    };
}

function applyParameters(parameters) {
    settings = { ...settings, ...(parameters || {}) };
}

function streamerAccount(runRequest) {
    const streamer = runRequest.firebot && runRequest.firebot.accounts && runRequest.firebot.accounts.streamer;
    if (!streamer) return undefined;
    return {
        username: streamer.username,
        displayName: streamer.displayName,
        userId: streamer.userId,
        broadcasterType: streamer.broadcasterType
    };
}

function registerCustomEventEffect(effectManager) {
    effectManager.registerEffect({
        definition: {
            id: EFFECT_ID,
            name: "Streamer.bot Bridge: Broadcast Custom Event",
            description: "Send a General.Custom event to Streamer.bot WebSocket clients via sb-bridge.",
            icon: "fad fa-broadcast-tower",
            categories: ["advanced", "integrations"],
            dependencies: []
        },
        optionsTemplate: `
            <eos-container header="JSON payload">
                <textarea ng-model="effect.payload" class="form-control" rows="6" replace-variables
                    placeholder='{"event": "my-event", "value": 1}'></textarea>
                <p class="muted" style="margin-top: 8px">Sent as the event's data. Non-JSON text is sent as {"message": "..."}.</p>
            </eos-container>
        `,
        optionsController: () => {},
        optionsValidator: (effect) => (effect.payload ? [] : ["A payload is required."]),
        onTriggerEvent: async ({ effect }) => {
            let data;
            try {
                data = JSON.parse(effect.payload);
            } catch (err) {
                data = { message: effect.payload };
            }
            post("/ingest/firebot/custom", data);
            return true;
        }
    });
}

async function run(runRequest) {
    logger = runRequest.modules.logger;
    applyParameters(runRequest.parameters);

    const { eventManager, effectManager } = runRequest.modules;

    // Firebot routes every event through eventManager.triggerEvent, so wrapping
    // it sees all of them (Twitch, Streamlabs, OBS, custom, ...).
    if (!restoreTriggerEvent) {
        const original = eventManager.triggerEvent;
        eventManager.triggerEvent = function (sourceId, eventId, meta, isManual, isRetrigger, isSimulation) {
            try {
                if (!isRetrigger && (settings.forwardManual || !isManual)) {
                    post("/ingest/firebot/event", {
                        sourceId,
                        eventId,
                        meta: meta || {},
                        isManual: !!isManual,
                        isSimulation: !!isSimulation
                    });
                }
            } catch (err) {
                logger.debug(`[sb-bridge] forward failed: ${err.message}`);
            }
            return original.apply(this, arguments);
        };
        restoreTriggerEvent = () => {
            eventManager.triggerEvent = original;
        };
    }

    try {
        registerCustomEventEffect(effectManager);
    } catch (err) {
        logger.warn(`[sb-bridge] could not register effect: ${err.message}`);
    }

    post("/ingest/firebot/hello", {
        firebotVersion: runRequest.firebot && runRequest.firebot.version,
        streamer: streamerAccount(runRequest)
    });
    logger.info(`[sb-bridge] forwarding Firebot events to ${settings.bridgeUrl}`);
}

function parametersUpdated(parameters) {
    applyParameters(parameters);
}

function stop() {
    if (restoreTriggerEvent) restoreTriggerEvent();
    restoreTriggerEvent = null;
}

module.exports = {
    getScriptManifest,
    getDefaultParameters,
    run,
    parametersUpdated,
    stop
};
