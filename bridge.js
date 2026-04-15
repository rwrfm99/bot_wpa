const http = require("http");
const { create } = require("@wppconnect-team/wppconnect");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_SOURCE_BOT_ID = process.env.TELEGRAM_SOURCE_BOT_ID;
const TELEGRAM_SOURCE_BOT_USERNAME = process.env.TELEGRAM_SOURCE_BOT_USERNAME;
const RAW_WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const WHATSAPP_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME;
const BRIDGE_KEY = process.env.BRIDGE_KEY;
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 3001);
const WHATSAPP_GROUP_ID =
  RAW_WHATSAPP_GROUP_ID && RAW_WHATSAPP_GROUP_ID !== "123456789@g.us"
    ? RAW_WHATSAPP_GROUP_ID
    : "";

let whatsappClient = null;
let resolvedWhatsappGroupId = null;

function normalizeUsername(username) {
  if (!username) return "";
  return username.replace(/^@/, "").toLowerCase();
}

function normalizeText(value) {
  return (value || "").toString().trim().toLowerCase();
}

function isValidOrigin(msg) {
  if (!msg || !msg.from) return false;

  if (TELEGRAM_SOURCE_BOT_ID && msg.from.id?.toString() !== TELEGRAM_SOURCE_BOT_ID) {
    return false;
  }

  const expectedUsername = normalizeUsername(TELEGRAM_SOURCE_BOT_USERNAME);
  if (expectedUsername) {
    const username = normalizeUsername(msg.from.username);
    if (username !== expectedUsername) return false;
  }

  return true;
}

function extractTelegramText(msg) {
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
  if (typeof msg.caption === "string" && msg.caption.trim()) return msg.caption.trim();
  return "";
}

function getChatDisplayName(chat) {
  return (
    chat?.name ||
    chat?.formattedTitle ||
    chat?.contact?.formattedName ||
    chat?.contact?.pushname ||
    "(sin nombre)"
  );
}

function htmlToWhatsapp(text) {
  return (text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?b>/gi, "*")
    .replace(/<\/?strong>/gi, "*")
    .replace(/<\/?code>/gi, "`")
    .replace(/<\/?i>/gi, "_")
    .replace(/<\/?em>/gi, "_")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function buildOutboundMessage(source, text) {
  const prettyText = htmlToWhatsapp(text);
  const now = new Date().toLocaleString();
  return [
    "╔════════════════════╗",
    "║   ALERTA BOT 🤖    ║",
    "╚════════════════════╝",
    "",
    `👤 *De:* ${source}`,
    "",
    "📨 *Mensaje:*",
    prettyText,
    "",
    `🕒 *Recibido:* ${now}`
  ].join("\n");
}

async function sendToWhatsapp(source, text) {
  if (!text || !text.trim()) {
    console.log("[BRIDGE] Mensaje vacio. No se envia.");
    return;
  }

  if (!whatsappClient || !resolvedWhatsappGroupId) {
    console.log("[WA] Aun no conectado o sin grupo resuelto. Mensaje omitido.");
    return;
  }

  const outbound = buildOutboundMessage(source, text.trim());
  await whatsappClient.sendText(resolvedWhatsappGroupId, outbound);
  console.log(`[OK] Reenviado a WhatsApp (${source}).`);
}

async function resolveWhatsappGroupId(client) {
  if (WHATSAPP_GROUP_ID) {
    console.log(`[WA] Usando grupo configurado por ID: ${WHATSAPP_GROUP_ID}`);
    return WHATSAPP_GROUP_ID;
  }

  if (!WHATSAPP_GROUP_NAME) {
    throw new Error("Debes configurar WHATSAPP_GROUP_ID o WHATSAPP_GROUP_NAME en .env");
  }

  const chats = await client.listChats({ onlyGroups: true });
  const targetName = normalizeText(WHATSAPP_GROUP_NAME);

  const matches = chats.filter((chat) => normalizeText(getChatDisplayName(chat)) === targetName);

  if (matches.length === 1) {
    const chat = matches[0];
    const chatId = chat?.id?._serialized || chat?.id;
    console.log(`[WA] Grupo encontrado por nombre: ${getChatDisplayName(chat)} => ${chatId}`);
    return chatId;
  }

  const partialMatches = chats.filter((chat) =>
    normalizeText(getChatDisplayName(chat)).includes(targetName)
  );

  if (partialMatches.length === 1) {
    const chat = partialMatches[0];
    const chatId = chat?.id?._serialized || chat?.id;
    console.log(`[WA] Grupo encontrado por coincidencia parcial: ${getChatDisplayName(chat)} => ${chatId}`);
    return chatId;
  }

  console.log("[WA] No se pudo resolver el grupo automaticamente. Lista de grupos disponibles:");
  for (const chat of chats) {
    const chatId = chat?.id?._serialized || chat?.id;
    console.log(`- ${getChatDisplayName(chat)} => ${chatId}`);
  }

  throw new Error(`No se encontro un grupo unico con WHATSAPP_GROUP_NAME=\"${WHATSAPP_GROUP_NAME}\"`);
}

async function initWhatsApp() {
  console.log("[WA] Conectando...");

  try {
    const client = await create({
      session: "monitor-session",
      autoClose: false,
      logQR: true,
      headless: true,
      catchQR: (base64Qr, asciiQR) => {
        console.log(asciiQR);
      },
      puppeteerOptions: {
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      }
    });

    whatsappClient = client;
    resolvedWhatsappGroupId = await resolveWhatsappGroupId(client);

    console.log("[WA] Conectado.");

    client.onStateChange((state) => {
      console.log("[WA] Estado:", state);
      if (state === "CONFLICT") client.forceRefork();
    });
  } catch (error) {
    console.error("[WA] Error al conectar:", error.message || error);
    setTimeout(initWhatsApp, 5000);
  }
}

async function initTelegram() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[TG] TELEGRAM_TOKEN/TELEGRAM_CHAT_ID no configurados. Se omite listener Telegram.");
    return;
  }

  console.log("[TG] Conectando...");
  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.on("polling_error", (error) => {
    console.error("[TG] Polling error:", error.message || error);
  });

  bot.on("message", async (msg) => {
    if (!msg?.chat?.id || msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    if (!isValidOrigin(msg)) return;

    const text = extractTelegramText(msg);
    if (!text) {
      console.log("[TG] Mensaje recibido sin texto/caption. No se reenvia.");
      return;
    }

    const senderName = msg.from.username
      ? `@${msg.from.username}`
      : msg.from.first_name || "bot";

    try {
      await sendToWhatsapp(senderName, text);
    } catch (error) {
      console.error("[WA] Error enviando mensaje desde Telegram:", error.message || error);
    }
  });

  console.log("[TG] Conectado. Escuchando mensajes...");
}

function startRelayServer() {
  if (!BRIDGE_KEY) {
    console.log("[API] BRIDGE_KEY no configurado. Endpoint /relay deshabilitado por seguridad.");
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/relay") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const incomingKey = req.headers["x-bridge-key"];
    if (incomingKey !== BRIDGE_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const text = (payload.text || "").toString().trim();
        const source = (payload.source || "bot-externo").toString().trim();

        if (!text) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Field 'text' is required" }));
          return;
        }

        await sendToWhatsapp(source, text);

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message || "Internal error" }));
      }
    });
  });

  server.listen(BRIDGE_PORT, () => {
    console.log(`[API] Endpoint activo en http://127.0.0.1:${BRIDGE_PORT}/relay`);
  });
}

async function main() {
  if (!WHATSAPP_GROUP_ID && !WHATSAPP_GROUP_NAME) {
    console.error("Falta variable de entorno: WHATSAPP_GROUP_ID o WHATSAPP_GROUP_NAME");
    process.exit(1);
  }

  await initWhatsApp();
  await initTelegram();
  startRelayServer();
}

main().catch((error) => {
  console.error("Error fatal:", error.message || error);
  process.exit(1);
});


