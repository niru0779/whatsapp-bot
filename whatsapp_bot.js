const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { exec } = require("child_process");

const AUTH_FOLDER = path.join(__dirname, "auth_info_baileys");

let activeSock = null;
let currentQrDataUrl = null;
let isBotConnected = false;
let browserOpened = false;

async function startWhatsAppBot() {
  console.log("==================================================");
  console.log("🤖 YouthUp Real WhatsApp Auto-Reply Bot Starting...");
  console.log("Store: youthup.in | Support: +91 95552 47659");
  console.log("==================================================");

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["YouthUp Store Bot", "Chrome", "1.0.0"]
  });

  activeSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
        const htmlPath = path.join(__dirname, "scan_qr.html");
        fs.writeFileSync(
          htmlPath,
          getQrHtml(currentQrDataUrl),
          "utf-8"
        );
        console.log("\n📲 [ACTION REQUIRED] QR Code ready in Website Admin Panel!");
        console.log("👉 youthup.in/admin > Tab 5 (WhatsApp Bot) par scan karein");
      } catch (e) {
        console.error("QR image error:", e);
      }
    }

    if (connection === "close") {
      isBotConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("⚠️ Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppBot();
      }
    } else if (connection === "open") {
      isBotConnected = true;
      currentQrDataUrl = null;
      console.log("\n✅ ==================================================");
      console.log("🎉 WHATSAPP BOT CONNECTED SUCCESSFULLY!");
      console.log("Bot is now actively listening for incoming customer messages.");
      console.log("Any customer message will receive an INSTANT AUTO-REPLY!");
      console.log("HTTP Outgoing Dispatcher active on port 5005");
      console.log("==================================================\n");
    }
  });

  // Listen for incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return; // Ignore messages sent by bot itself

      const sender = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      console.log(`📩 Incoming message from ${sender}: "${text}"`);
      const lower = text.toLowerCase().trim();

      // 0. Direct 1-Tap Order Confirmation ("1", "confirm", "yes", "haan", "ok")
      if (
        lower === "1" ||
        lower === "confirm" ||
        lower === "yes" ||
        lower === "haan" ||
        lower === "ok" ||
        lower === "done" ||
        lower.includes("order confirm") ||
        lower.includes("confirm karo") ||
        lower.includes("dispatch kar do")
      ) {
        const phone = sender.replace(/[^0-9]/g, "").slice(-10);
        // Mark confirmed in store API
        try {
          fetch("https://youthup.in/api/orders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerPhone: phone, status: "CONFIRMED" })
          }).catch(() => {});
        } catch (e) {}

        const replyText =
          `🎉 *Aapka Order Successfully CONFIRM Ho Gaya Hai!*\n\n` +
          `✅ *Status:* Locked in Warehouse Packaging Queue\n` +
          `📦 Hamari team aapka parcel pack karke Delhivery/BlueDart express se dispatch kar rahi hai.\n` +
          `🚚 *Delivery Time:* 3-4 Business Days mein aapke address par deliver ho jayega.\n\n` +
          `⚡ *Speed Up (VIP Delivery Offer):*\n` +
          `Agar aap sirf *₹50 advance UPI* pay karte hain toh parcel *aaj hi VIP priority* se dispatch hoga aur delivery par *₹50 KAM* COD dena hoga:\n` +
          `🔘 *1-Tap Pay via PhonePe / GPay / Paytm:*\n` +
          `👉 https://youthup.in/pay\n\n` +
          `🔗 *Live Order Tracking:* https://youthup.in/track\n\n` +
          `Shukriya! Team YouthUp 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied Order Confirmation to ${sender}`);
        return;
      }

      // 1. VIP ₹50 Advance Confirmation / Screenshot
      if (
        lower.includes("50") ||
        lower.includes("paid") ||
        lower.includes("pay kar diya") ||
        lower.includes("done") ||
        lower.includes("advance") ||
        lower.includes("screenshot")
      ) {
        const replyText =
          `🎉 *Shukriya! Aapka ₹50 VIP Advance Payment Receive Ho Gaya Hai!*\n\n` +
          `Aapka order *VIP Superfast Dispatch* queue mein mark kar diya gaya hai.\n\n` +
          `⚡ *Benefit:* Delivery ke waqt parcel aane par aapko total amount mein se *Flat ₹50 KAM* dena hoga (Remaining COD only).\n` +
          `📦 Hamari team aaj hi parcel Delhivery/BlueDart express se dispatch kar degi.\n\n` +
          `🚚 *Live Order Tracking Link:* https://youthup.in/track\n\n` +
          `YouthUp Store par bharosa karne ke liye dil se dhanyawad! 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied VIP 50 Confirmation to ${sender}`);
        return;
      }

      // 2. Order Intent (Matches the template from website)
      if (
        lower.includes("cash on delivery par chahiye") ||
        lower.includes("order confirm karein") ||
        lower.includes("order karna hai") ||
        (lower.includes("mujhe") && lower.includes("chahiye"))
      ) {
        const replyText =
          `Namaste! 🙏 *YouthUp Smart Store* se order karne ke liye bohot shukriya.\n\n` +
          `Aapka order receive ho gaya hai! Kripya apna *Delivery Address* neeche diye format mein bhejein taaki hum turant parcel dispatch kar sakein:\n\n` +
          `👤 *1. Pura Naam:*\n` +
          `🏠 *2. Makaan No / Gali / Colony:*\n` +
          `📍 *3. Shahar (City) & State:*\n` +
          `📮 *4. Pincode (6 Digits):*\n\n` +
          `🚚 *Payment:* 100% Free Cash on Delivery (COD) - Paisa parcel milne par dein.\n` +
          `⚡ *VIP Delivery Offer:* Advance ₹50 UPI pay karne par aaj hi Superfast dispatch hoga!\n` +
          `🔗 *Track Order:* https://youthup.in/track\n\n` +
          `_(Aap chahein toh seedha hamari official website https://youthup.in par jakar bhi 1-click me order book kar sakte hain)_`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied with Order Confirmation Form to ${sender}`);
        return;
      }

      // 3. Customer sent Address details
      if (
        (lower.includes("pin") || lower.includes("pincode") || /\b\d{6}\b/.test(lower)) &&
        (lower.includes("naam") || lower.includes("house") || lower.includes("gali") || lower.includes("road") || lower.includes("nagar") || lower.includes("colony"))
      ) {
        const replyText =
          `🎉 *Aapki Delivery Details Mil Gayi Hain!*\n\n` +
          `Aapka Cash on Delivery order successfully confirm kar diya gaya hai.\n\n` +
          `📦 *Status:* Ready for Warehouse Dispatch\n` +
          `🚚 *Delivery:* 3-5 Din mein parcel aapke ghar deliver ho jayega.\n` +
          `🔗 *Live Tracking Link:* https://youthup.in/track\n\n` +
          `Thank you for shopping with *YouthUp Store*! 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied Address Confirmation to ${sender}`);
        return;
      }

      // 4. Delivery / Time questions
      if (lower.includes("delivery") || lower.includes("din") || lower.includes("kab tak") || lower.includes("time") || lower.includes("track")) {
        const replyText =
          `⚡ *Delivery & Tracking Details:*\n\n` +
          `• Metro Cities: 2 se 3 din\n` +
          `• All India: 3 se 5 working days\n\n` +
          `Aap apna live parcel yahan track kar sakte hain:\n` +
          `👉 *https://youthup.in/track*\n\n` +
          `Delhivery/BlueDart express courier dwara dispatch hota hai. 100% Free Delivery! 🚚`;

        await sock.sendMessage(sender, { text: replyText });
        return;
      }

      // 5. COD / Payment questions
      if (lower.includes("cod") || lower.includes("cash") || lower.includes("advance") || lower.includes("payment")) {
        const replyText =
          `💵 *100% Free Cash on Delivery (COD)!*\n\n` +
          `Aapko pehle 1 rupaya bhi dene ki zaroorat nahi hai. Parcel ghar pahunchne par cash dein ya delivery boy ke scanner par UPI karein.\n\n` +
          `⚡ *Special VIP Offer:* Agar aap ₹50 advance UPI se pay karte hain, toh delivery boy ko ₹50 kam dena hoga aur order aaj hi priority dispatch hoga!`;

        await sock.sendMessage(sender, { text: replyText });
        return;
      }

      // 6. Generic Greeting (Hi, Hello, Namaste)
      if (lower === "hi" || lower === "hello" || lower === "namaste" || lower === "hey" || lower === "help") {
        const replyText =
          `Namaste! 🙏 *YouthUp Smart Store* mein aapka swagat hai.\n\n` +
          `Main aapki kya sahayata kar sakta hoon?\n\n` +
          `1️⃣ Product Order karne ke liye product ka naam bhejein\n` +
          `2️⃣ Free Cash on Delivery uplabdh hai\n` +
          `3️⃣ Order Track Karein: https://youthup.in/track\n` +
          `4️⃣ Official Website: https://youthup.in\n\n` +
          `Aapko kaunsa product chahiye?`;

        await sock.sendMessage(sender, { text: replyText });
        return;
      }

      // 7. Default Auto-Reply
      const defaultReply =
        `Namaste! 🙏 YouthUp Store Support Team ko aapka message mil gaya hai.\n\n` +
        `Order book karne ya live parcel track karne ke liye visit karein: https://youthup.in/track\n\n` +
        `Hamara team member jald se jald aapse connect karega.`;

      await sock.sendMessage(sender, { text: defaultReply });
    } catch (err) {
      console.error("Error processing incoming message:", err);
    }
  });
}

// -------------------------------------------------------------
// HTTP Server for Outgoing Order Alerts from Next.js (Port 5005)
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "POST" && req.url === "/send-order-alert") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const { phone, message } = parsed;

        if (!phone || !message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "phone and message required" }));
        }

        if (!activeSock) {
          res.writeHead(503, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "WhatsApp socket not initialized" }));
        }

        const cleanPhone = phone.replace(/[^0-9]/g, "").slice(-10);
        const jid = `91${cleanPhone}@s.whatsapp.net`;

        await activeSock.sendMessage(jid, { text: message });
        console.log(`🚀 [OUTGOING WHATSAPP DISPATCH] Successfully sent order alert to ${jid}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, sentTo: jid }));
      } catch (err) {
        console.error("Error dispatching outgoing order alert:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      isConnected: isBotConnected,
      qrDataUrl: currentQrDataUrl
    }));
  } else if (req.url === "/api/disconnect") {
    try {
      if (activeSock) {
        try { activeSock.logout(); } catch(e) {}
      }
      isBotConnected = false;
      currentQrDataUrl = null;
      try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e) {}
      startWhatsAppBot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Logged out. Starting fresh QR scan..." }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === "/qr" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getQrHtml(currentQrDataUrl));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "YouthUp WhatsApp Bot HTTP Server Active", isConnected: isBotConnected }));
  }
});

function getQrHtml(qrDataUrl) {
  if (isBotConnected) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YouthUp WhatsApp Connected</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #ecfdf5; margin: 0; }
    .card { background: white; padding: 36px 30px; border-radius: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); text-align: center; max-width: 400px; }
    .icon { font-size: 54px; margin-bottom: 12px; }
    h2 { color: #065f46; margin: 0 0 10px 0; font-size: 22px; font-weight: 900; }
    p { font-size: 14px; color: #374151; line-height: 1.6; margin: 0; }
    .badge { background: #d1fae5; color: #047857; font-size: 12px; font-weight: 800; padding: 6px 14px; border-radius: 20px; display: inline-block; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎉</div>
    <div class="badge">Status: Live & Connected</div>
    <h2>WhatsApp Bot Connected!</h2>
    <p>Aapka WhatsApp number successfully link ho gaya hai.<br><br>Ab website par aane wale har naye order par <b>automatic WhatsApp message</b> customer ke phone par seedha chala jayega!</p>
  </div>
</body>
</html>`;
  }

  if (!qrDataUrl) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YouthUp WhatsApp Bot</title>
  <meta http-equiv="refresh" content="3">
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f9fafb; margin: 0; }
    .card { background: white; padding: 36px 30px; border-radius: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); text-align: center; max-width: 400px; }
    h2 { color: #111827; margin: 0 0 10px 0; }
    p { font-size: 14px; color: #4b5563; }
    .spinner { width: 36px; height: 36px; border: 4px solid #10b981; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>QR Code Generate Ho Raha Hai...</h2>
    <p>Kripya 3-5 second intezar karein, yeh page automatically refresh ho jayega.</p>
  </div>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Scan WhatsApp QR Code - YouthUp</title>
  <meta http-equiv="refresh" content="12">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f0fdf4; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: white; padding: 32px 24px; border-radius: 28px; box-shadow: 0 15px 35px rgba(0,0,0,0.08); text-align: center; max-width: 380px; width: 100%; border: 1px solid #d1fae5; }
    .badge { background: #d1fae5; color: #065f46; font-size: 12px; font-weight: 800; padding: 5px 12px; border-radius: 20px; display: inline-block; margin-bottom: 14px; }
    h2 { color: #065f46; margin: 0 0 12px 0; font-size: 22px; font-weight: 900; }
    ol { text-align: left; font-size: 13px; color: #374151; line-height: 1.6; padding-left: 20px; margin: 0 0 18px 0; }
    .qr-box { background: #ffffff; padding: 12px; border-radius: 20px; border: 2px solid #10b981; display: inline-block; box-shadow: 0 4px 12px rgba(16,185,129,0.15); }
    img { width: 260px; height: 260px; display: block; border-radius: 12px; }
    .sub { font-size: 11px; color: #9ca3af; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Official YouthUp WhatsApp Bot</div>
    <h2>Scan QR Code</h2>
    <ol>
      <li>Apne phone mein WhatsApp kholein</li>
      <li>Upar 3-Dots &gt; <b>Linked Devices</b> dabayein</li>
      <li><b>Link a Device</b> dabakar is QR Code ko scan karein:</li>
    </ol>
    <div class="qr-box">
      <img src="${qrDataUrl}" alt="Scan QR Code" />
    </div>
    <div class="sub">Yeh QR Code har 12 second mein automatically refresh hota hai</div>
  </div>
</body>
</html>`;
}

const PORT = process.env.PORT || 5005;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ Bot HTTP Alert Dispatcher listening on port ${PORT}`);
});

// -------------------------------------------------------------
// 24x7 Cloud Order Watcher: Automatically picks up new orders
// from https://youthup.in and dispatches WhatsApp messages!
// -------------------------------------------------------------
const SENT_ALERTS_FILE = path.join(__dirname, "sent_alerts.json");

function getSentAlerts() {
  try {
    if (fs.existsSync(SENT_ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(SENT_ALERTS_FILE, "utf-8"));
    }
  } catch (e) {}
  return [];
}

function markAlertSent(orderId) {
  try {
    const list = getSentAlerts();
    if (!list.includes(orderId)) {
      list.push(orderId);
      fs.writeFileSync(SENT_ALERTS_FILE, JSON.stringify(list, null, 2), "utf-8");
    }
  } catch (e) {}
}

async function checkAndSendNewOrderAlerts() {
  if (!activeSock) return;

  try {
    const res = await fetch("https://youthup.in/api/orders");
    const data = await res.json();
    if (!data.success || !Array.isArray(data.orders)) return;

    const sentList = getSentAlerts();

    for (const order of data.orders) {
      if (!order.orderId || sentList.includes(order.orderId)) {
        continue;
      }

      const phone = order.customer?.phone;
      if (!phone) {
        markAlertSent(order.orderId);
        continue;
      }

      const cleanPhone = phone.replace(/[^0-9]/g, "").slice(-10);
      if (cleanPhone.length !== 10) {
        markAlertSent(order.orderId);
        continue;
      }

      const jid = `91${cleanPhone}@s.whatsapp.net`;
      const remainingCod = Math.max(0, (order.item?.totalAmount || 0) - 50);
      const confirmUrl = `https://youthup.in/confirm-order?id=${order.orderId}`;
      const payUrl = `https://youthup.in/pay?id=${order.orderId}`;
      const trackUrl = `https://youthup.in/track?id=${order.orderId}`;

      const messageText = 
`🎉 *Namaste ${order.customer?.name || "Customer"} Ji!*
YouthUp Store se aapka order successfully book ho gaya hai.

📦 *Order ID:* ${order.orderId}
🏷️ *Product:* ${order.item?.title || "YouthUp Product"}
💰 *Total Amount:* Rs. ${order.item?.totalAmount || 0} (${order.paymentMethod || "COD"})
📍 *Delivery Address:* ${order.customer?.address || ""}, ${order.customer?.city || ""} - ${order.customer?.pincode || ""}

✅ *STEP 1: Order Confirm Karein:*
Bas is message par *1* ya *CONFIRM* reply karein (ya link dabayein: ${confirmUrl})

⚡ *STEP 2: VIP FAST DISPATCH (Fast Delivery Offer):*
Agar aap sirf *Rs 50* advance UPI se pay kar dete hain, toh aapka parcel aaj hi VIP Priority se pack hokar express courier se nikal jayega, aur delivery ke waqt Flat Rs 50 KAM (sirf *Rs. ${remainingCod}*) COD dena hoga!

🔘 *1-Tap Pay via PhonePe / GPay / Paytm:*
👉 ${payUrl}

🚚 *Live Order Status Track Karein:*
${trackUrl}

Aapka parcel 3-5 working days mein deliver ho jayega. Koi sawaal ho toh is message par reply karein. Dhanyawad! 🙏
*YouthUp India Support: +91 95552 47659*`;

      try {
        await activeSock.sendMessage(jid, { text: messageText });
        console.log(`\n🚀 [AUTO-ALERT SENT] Order #${order.orderId} automatically sent on WhatsApp to +91${cleanPhone}!`);
        markAlertSent(order.orderId);
      } catch (sendErr) {
        console.error(`Failed to dispatch alert to ${jid}:`, sendErr.message);
      }
    }
  } catch (err) {
    // Network retry silent
  }
}

// Check every 4 seconds for new customer orders
setInterval(checkAndSendNewOrderAlerts, 4000);
console.log("👀 Cloud Order Watcher active: Checking https://youthup.in every 4 seconds for new orders!");

// 24x7 Cloud Self-Ping (Prevents Render free tier from sleeping)
if (process.env.RENDER_EXTERNAL_URL) {
  console.log("⚡ Render 24x7 Self-Ping Keepalive registered for:", process.env.RENDER_EXTERNAL_URL);
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/status`).catch(() => {});
  }, 10 * 60 * 1000);
}

startWhatsAppBot().catch(console.error);
