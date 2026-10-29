const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");

const AUTH_FOLDER = path.join(__dirname, "auth_info_baileys");
const CONTACTED_CUSTOMERS_FILE = path.join(__dirname, "contacted_customers.json");
const ORDER_TRACKING_FILE = path.join(__dirname, "order_tracking_status.json");
const SENT_ALERTS_FILE = path.join(__dirname, "sent_alerts.json");

let activeSock = null;
let currentQrDataUrl = null;
let isBotConnected = false;

// -------------------------------------------------------------
// 🔒 PRIVACY WHITELIST: Sirf wahi numbers jinhe website se message gaya ho
// -------------------------------------------------------------
let contactedCustomers = new Set();

function loadContactedCustomers() {
  try {
    if (fs.existsSync(CONTACTED_CUSTOMERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONTACTED_CUSTOMERS_FILE, "utf-8"));
      contactedCustomers = new Set(data);
    }
  } catch (e) {
    contactedCustomers = new Set();
  }
}

function recordContactedCustomer(rawPhone) {
  if (!rawPhone) return;
  const cleanPhone = String(rawPhone).replace(/[^0-9]/g, "").slice(-10);
  if (cleanPhone.length === 10) {
    contactedCustomers.add(cleanPhone);
    try {
      fs.writeFileSync(CONTACTED_CUSTOMERS_FILE, JSON.stringify(Array.from(contactedCustomers), null, 2));
    } catch (e) {}
  }
}

// -------------------------------------------------------------
// 📦 ORDER TRACKING & VIP ADVANCE STATE HELPERS
// -------------------------------------------------------------
function getOrderTrackingMap() {
  try {
    if (fs.existsSync(ORDER_TRACKING_FILE)) {
      return JSON.parse(fs.readFileSync(ORDER_TRACKING_FILE, "utf-8"));
    }
  } catch (e) {}
  return {};
}

function saveOrderTrackingMap(map) {
  try {
    fs.writeFileSync(ORDER_TRACKING_FILE, JSON.stringify(map, null, 2), "utf-8");
  } catch (e) {}
}

function getOrderByPhone(rawPhone) {
  if (!rawPhone) return null;
  const cleanPhone = String(rawPhone).replace(/[^0-9]/g, "").slice(-10);
  const map = getOrderTrackingMap();
  for (const id in map) {
    if (map[id].phone === cleanPhone) {
      return map[id];
    }
  }
  return null;
}

// Store database se sabhi customer numbers aur order details sync karein
async function syncStoreCustomers() {
  try {
    const res = await fetch("https://youthup.in/api/orders");
    const data = await res.json();
    const trackingMap = getOrderTrackingMap();

    if (data && data.success && Array.isArray(data.orders)) {
      for (const o of data.orders) {
        if (o.customer?.phone) {
          const p = String(o.customer.phone).replace(/[^0-9]/g, "").slice(-10);
          if (p.length === 10) contactedCustomers.add(p);

          // Populate order tracking map if not exists
          if (o.orderId && !trackingMap[o.orderId]) {
            trackingMap[o.orderId] = {
              orderId: o.orderId,
              phone: p,
              customerName: o.customer?.name || "Customer",
              productTitle: o.item?.title || "YouthUp Product",
              totalAmount: o.item?.totalAmount || 0,
              createdAt: o.createdAt || new Date().toISOString(),
              paidVip: o.paymentStatus === "PAID" || o.paymentStatus === "VIP_TOKEN_PAID",
              reminderSent: false
            };
          }
        }
      }
      saveOrderTrackingMap(trackingMap);
    }

    try {
      const abRes = await fetch("https://youthup.in/api/abandoned-cart");
      const abData = await abRes.json();
      if (abData && abData.success && Array.isArray(abData.abandonedCarts)) {
        for (const c of abData.abandonedCarts) {
          if (c.phone) {
            const p = String(c.phone).replace(/[^0-9]/g, "").slice(-10);
            if (p.length === 10) contactedCustomers.add(p);
          }
        }
      }
    } catch (e) {}

    fs.writeFileSync(CONTACTED_CUSTOMERS_FILE, JSON.stringify(Array.from(contactedCustomers), null, 2));
    console.log(`📋 [CUSTOMER SYNC] Total ${contactedCustomers.size} verified store numbers loaded into auto-reply whitelist.`);
  } catch (err) {
    // Offline or retry
  }
}

loadContactedCustomers();
syncStoreCustomers();
setInterval(syncStoreCustomers, 5 * 60 * 1000);

// -------------------------------------------------------------
// 🤖 WHATSAPP CLIENT INITIALIZATION & MESSAGE HANDLING
// -------------------------------------------------------------
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
      console.log("Bot is actively listening for verified customer messages.");
      console.log("Outgoing HTTP Dispatcher active on port 5005");
      console.log("==================================================\n");
    }
  });

  // Listen for incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return; // Ignore messages sent by bot itself

      const sender = msg.key.remoteJid;
      if (!sender) return;

      // 1. 🛑 GROUPS & BROADCASTS KO BILKUL IGNORE KAREIN
      if (sender.endsWith("@g.us") || sender.endsWith("@broadcast") || sender === "status@broadcast") {
        return;
      }

      const senderPhone = sender.replace(/[^0-9]/g, "").slice(-10);
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.ephemeralMessage?.message?.conversation ||
        msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
        msg.message.viewOnceMessage?.message?.conversation ||
        msg.message.viewOnceMessageV2?.message?.extendedTextMessage?.text ||
        "";

      const lower = text.toLowerCase().trim();
      const hasImage = Boolean(msg.message.imageMessage || msg.message.documentMessage);

      // Customer Recognition
      const isContactedCustomer = contactedCustomers.has(senderPhone);

      // 0. Direct 1-Tap Order Confirmation ("1", "confirm", "yes", "haan", "ok")
      const isConfirmIntent =
        lower === "1" ||
        lower === "confirm" ||
        lower === "yes" ||
        lower === "haan" ||
        lower === "ok" ||
        lower.startsWith("1 ") ||
        lower.endsWith(" 1") ||
        lower.includes("order confirm") ||
        lower.includes("confirm karo") ||
        lower.includes("dispatch kar do");

      // 1. Buyer wants to Pay ₹50 Token ("50", "token", "advance kaise du")
      const isVipTokenRequest =
        lower === "50" ||
        lower === "token" ||
        lower === "advance" ||
        lower.includes("50 kaise") ||
        lower.includes("token kaise") ||
        lower.includes("advance kaise") ||
        lower.includes("upi id") ||
        lower.includes("qr code");

      // 2. Buyer has PAID ₹50 Advance / Sent Screenshot
      const isVipPaymentDone =
        lower.includes("paid") ||
        lower.includes("pay kar diya") ||
        lower.includes("bhej diya") ||
        lower.includes("done") ||
        lower.includes("screenshot") ||
        lower.includes("ho gaya") ||
        (hasImage && (lower.includes("50") || lower.includes("pay") || lower === ""));

      // 3. Buyer asks about Tracking / "Kahan tak pahucha"
      const isTrackingInquiry =
        lower.includes("kahan") ||
        lower.includes("pahucha") ||
        lower.includes("pahuche") ||
        lower.includes("track") ||
        lower.includes("status") ||
        lower.includes("kab tak") ||
        lower.includes("kab aayega") ||
        lower.includes("kab milega") ||
        lower.includes("delivery");

      // 4. Check: Kya ye message website ke "Order on WhatsApp" button se aaya hai?
      const isWebsiteOrderClick =
        lower.includes("cash on delivery par chahiye") ||
        lower.includes("youthup") ||
        lower.includes("youthup.in") ||
        (lower.includes("order") && lower.includes("chahiye"));

      // 5. Customer sent Address details
      const isAddressDetails =
        (lower.includes("pin") || lower.includes("pincode") || /\b\d{6}\b/.test(lower)) &&
        (lower.includes("naam") || lower.includes("house") || lower.includes("gali") || lower.includes("road") || lower.includes("nagar") || lower.includes("colony") || lower.includes("shahar"));

      // 6. COD / Payment inquiry
      const isPaymentInquiry =
        lower.includes("cod") || lower.includes("cash on delivery") || lower.includes("advance payment");

      const isKnownCustomerAction =
        isConfirmIntent ||
        isVipTokenRequest ||
        isVipPaymentDone ||
        isWebsiteOrderClick ||
        isAddressDetails;

      // 🛑 STRICT PRIVACY RULE:
      // Agar na toh yeh koi order action hai, aur na hi yeh kisi verified store customer ka sawaal hai:
      // TOH KISI BHI PERSONAL CHAT / BANK / FRIEND / FAMILY KO BILKUL REPLY NAHI JAYEGA!
      if (!isKnownCustomerAction && !isContactedCustomer) {
        console.log(`⏭️ [SKIPPED NON-CUSTOMER / PERSONAL CHAT] ${senderPhone}: "${text}"`);
        return;
      }

      // Customer ko whitelist me record karein
      recordContactedCustomer(senderPhone);
      console.log(`📩 [VERIFIED CUSTOMER] ${senderPhone}: "${text}"`);

      // Order lookup (local cache + live sync fallback)
      let customerOrder = getOrderByPhone(senderPhone);
      if (!customerOrder) {
        try {
          const res = await fetch("https://youthup.in/api/orders");
          const data = await res.json();
          if (data && data.success && Array.isArray(data.orders)) {
            for (const o of data.orders) {
              const p = String(o.customer?.phone || "").replace(/[^0-9]/g, "").slice(-10);
              if (p === senderPhone) {
                customerOrder = {
                  orderId: o.orderId,
                  phone: p,
                  customerName: o.customer?.name || "Customer",
                  productTitle: o.item?.title || "YouthUp Product",
                  totalAmount: o.item?.totalAmount || 0,
                  createdAt: o.createdAt || new Date().toISOString(),
                  paidVip: o.paymentStatus === "PAID" || o.paymentStatus === "VIP_TOKEN_PAID",
                  reminderSent: false
                };
                const trackingMap = getOrderTrackingMap();
                trackingMap[o.orderId] = customerOrder;
                saveOrderTrackingMap(trackingMap);
                break;
              }
            }
          }
        } catch (e) {}
      }

      // ---------------------------------------------------------
      // ORDER INTENT HANDLERS:
      // ---------------------------------------------------------

      // 1. TRACKING INQUIRY ("Kahan tak pahucha", "Track", "Status")
      if (isTrackingInquiry) {
        const orderId = customerOrder ? customerOrder.orderId : "";
        const trackUrl = orderId ? `https://youthup.in/track?id=${orderId}` : `https://youthup.in/track`;

        const replyText =
          `📍 *Aapka Live Order Tracker Link:*\n\n` +
          `👉 ${trackUrl}\n\n` +
          `📦 *Order ID:* ${orderId || "Latest Order"}\n` +
          `🚚 *Courier Partner:* Delhivery / BlueDart Express\n` +
          `⏱️ *Expected Delivery:* 3-5 Working Days\n\n` +
          `Upar diye link par click karke aap parcel ki live location dekh sakte hain. Dhanyawad! 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Replied Tracking Link to ${senderPhone}`);
        return;
      }

      // 2. VIP PAYMENT DONE ("paid", "screenshot", "advance bhej diya")
      if (isVipPaymentDone) {
        const trackingMap = getOrderTrackingMap();
        let totalAmt = 0;
        let orderId = "";

        if (customerOrder && customerOrder.orderId) {
          orderId = customerOrder.orderId;
          totalAmt = customerOrder.totalAmount || 0;
          if (trackingMap[orderId]) {
            trackingMap[orderId].paidVip = true;
            saveOrderTrackingMap(trackingMap);
          }
        }

        const remainingCod = Math.max(0, totalAmt > 0 ? totalAmt - 50 : 0);

        try {
          fetch("https://youthup.in/api/orders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerPhone: senderPhone, paymentStatus: "VIP_TOKEN_PAID" })
          }).catch(() => {});
        } catch (e) {}

        const replyText =
          `👑 *YOUTHUP VIP CUSTOMER - FAST DELIVERY ACTIVATED!*\n\n` +
          `🎉 *Shukriya! Aapka ₹50 Advance Token Receive Ho Gaya Hai.*\n\n` +
          `⚡ *Delivery Status:* Superfast VIP Priority Dispatch Queue\n` +
          `📦 Hamari warehouse team aapka parcel aaj hi Delhivery/BlueDart express se dispatch kar rahi hai.\n\n` +
          `💰 *Updated COD Balance Details:*\n` +
          (totalAmt > 0 ? `• Total Order Amount: ₹${totalAmt}\n` : "") +
          `• Advance Token Paid: -₹50\n` +
          (remainingCod > 0 ? `• *Delivery Boy Ko Dene Honge: Sirf ₹${remainingCod} (Remaining COD)*\n\n` : `• *Remaining Balance: Flat ₹50 KAM dena hoga delivery par!*\n\n`) +
          `📍 *Order Tracking:* Parcel live track karne ke liye bas *TRACK* likhkar bhejein.\n\n` +
          `YouthUp Store par bharosa karne ke liye dil se dhanyawad! 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Replied VIP Customer Confirmation to ${senderPhone}`);
        return;
      }

      // 3. BUYER REPLIED "50" (Wants to pay VIP advance token)
      // 1-Click direct UPI open link + 1-Tap web UPI link
      if (isVipTokenRequest) {
        const orderId = customerOrder?.orderId || "YU-ORDER";
        const totalAmt = customerOrder?.totalAmount || 0;
        const remainingCod = totalAmt > 50 ? totalAmt - 50 : 0;
        const directUpiLink = `upi://pay?pa=9555247659@paytm&pn=YouthUp&am=50&tn=VIP_${orderId}`;
        const payWebUrl = `https://youthup.in/pay?id=${orderId}`;

        const replyText =
          `⚡ *₹50 Advance Token Payment (VIP Fast Delivery):*\n\n` +
          `Aap neeche diye gaye link par click karke 1-Tap mein seedha kisi bhi UPI App (PhonePe / Google Pay / Paytm) se ₹50 send kar sakte hain:\n\n` +
          `🔘 *1-CLICK DIRECT UPI OPEN:*\n` +
          `👉 (Direct UPI App: ${directUpiLink})\n\n` +
          `🌐 *Ya 1-Click Pay Link:*\n` +
          `👉 ${payWebUrl}\n\n` +
          `📱 *Manual UPI Details:*\n` +
          `• UPI ID: 9555247659@paytm\n` +
          `• Account Name: YouthUp\n` +
          `• Amount: ₹50\n` +
          `• Note: VIP_${orderId}\n\n` +
          `✅ *Pay karne ke baad yahan SCREENSHOT ya "PAID" likhkar bhej dein.*\n\n` +
          `⚡ *Fayde:*\n` +
          `1. Parcel aaj hi VIP Priority se express courier se dispatch hoga.\n` +
          (remainingCod > 0
            ? `2. Delivery ke waqt flat ₹50 KAM (sirf *₹${remainingCod}*) COD dena hoga!`
            : `2. Delivery ke waqt flat ₹50 KAM COD dena hoga!`);

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Sent VIP Token UPI Instructions to ${senderPhone}`);
        return;
      }

      // 4. BUYER REPLIED "1" / "CONFIRM"
      if (isConfirmIntent) {
        try {
          fetch("https://youthup.in/api/orders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerPhone: senderPhone, status: "CONFIRMED" })
          }).catch(() => {});
        } catch (e) {}

        const replyText =
          `🎉 *Aapka Order Successfully CONFIRM Ho Gaya Hai!*\n\n` +
          `✅ *Status:* Locked in Warehouse Packaging Queue\n` +
          `📦 Hamari team aapka parcel pack karke Delhivery/BlueDart express se dispatch kar rahi hai.\n` +
          `🚚 *Delivery Time:* 3-4 Business Days mein aapke address par deliver ho jayega.\n\n` +
          `🔘 *[ ⚡ UPGRADE TO VIP FAST DELIVERY ]*\n` +
          `Agar aap sirf *₹50 advance token* UPI se pay karte hain toh parcel *aaj hi VIP priority* se dispatch hoga aur delivery par *₹50 KAM* COD dena hoga:\n` +
          `👉 Token pay karne ke liye bas *50* reply karein.\n\n` +
          `Shukriya! Team YouthUp 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied Order Confirmation to ${senderPhone}`);
        return;
      }

      // 5. WEBSITE ORDER CLICK (Initiated from website WhatsApp button)
      if (isWebsiteOrderClick) {
        const replyText =
          `Namaste! 🙏 *YouthUp Smart Store* se order karne ke liye bohot shukriya.\n\n` +
          `Aapka order receive ho gaya hai! Kripya apna *Delivery Address* neeche diye format mein bhejein taaki hum turant parcel dispatch kar sakein:\n\n` +
          `👤 *1. Pura Naam:*\n` +
          `🏠 *2. Makaan No / Gali / Colony:*\n` +
          `📍 *3. Shahar (City) & State:*\n` +
          `📮 *4. Pincode (6 Digits):*\n\n` +
          `🚚 *Payment:* 100% Free Cash on Delivery (COD) - Paisa parcel milne par dein.\n` +
          `🔘 *[ ⚡ PAY ₹50 VIP TOKEN ]* ➔ Fast delivery ke liye bas *50* reply karein!`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied with Order Confirmation Form to ${senderPhone}`);
        return;
      }

      // 6. CUSTOMER SENT ADDRESS DETAILS
      if (isAddressDetails) {
        const replyText =
          `🎉 *Aapki Delivery Details Mil Gayi Hain!*\n\n` +
          `Aapka Cash on Delivery order successfully confirm kar diya gaya hai.\n\n` +
          `📦 *Status:* Ready for Warehouse Dispatch\n` +
          `🚚 *Delivery:* 3-5 Din mein parcel aapke ghar deliver ho jayega.\n\n` +
          `🔘 *[ ⚡ FAST DELIVERY VIP OFFER ]*\n` +
          `Agar aap ₹50 advance token pay karte hain toh delivery boy ko ₹50 kam dena hoga aur parcel aaj hi VIP Priority se dispatch hoga!\n` +
          `👉 Pay karne ke liye bas *50* reply karein.\n\n` +
          `Thank you for shopping with *YouthUp Store*! 🙏`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`🤖 Auto-replied Address Confirmation to ${senderPhone}`);
        return;
      }

      // 7. COD INQUIRY (Verified store customers only)
      if (isPaymentInquiry && isContactedCustomer) {
        const replyText =
          `💵 *100% Free Cash on Delivery (COD)!*\n\n` +
          `Aapko pehle 1 rupaya bhi dene ki zaroorat nahi hai. Parcel ghar pahunchne par cash dein ya delivery boy ke scanner par UPI karein.\n\n` +
          `🔘 *[ ⚡ SPECIAL VIP OFFER ]*\n` +
          `Agar aap ₹50 advance token UPI se pay karte hain, toh delivery boy ko ₹50 kam dena hoga aur order aaj hi priority dispatch hoga!\n` +
          `👉 Token pay karne ke liye bas *50* reply karein.`;

        await sock.sendMessage(sender, { text: replyText });
        return;
      }

      // 8. GENERIC GREETING (Hi/Hello - Verified store customers only)
      if ((lower === "hi" || lower === "hello" || lower === "namaste" || lower === "help") && isContactedCustomer) {
        const replyText =
          `Namaste! 🙏 *YouthUp Smart Store* mein aapka swagat hai.\n\n` +
          `Main aapki kya sahayata kar sakta hoon?\n\n` +
          `🔘 *[ ✅ CONFIRM ORDER ]* ➔ Reply *1*\n` +
          `🔘 *[ ⚡ VIP FAST DELIVERY ]* ➔ Reply *50*\n` +
          `🔘 *[ 📍 TRACK ORDER ]* ➔ Reply *TRACK*\n\n` +
          `Hamari team aapki poori madad karegi!`;

        await sock.sendMessage(sender, { text: replyText });
        return;
      }

    } catch (err) {
      console.error("Error processing incoming message:", err);
    }
  });
}

// -------------------------------------------------------------
// ⏰ AUTOMATED 3-4 HOUR VIP REMINDER ENGINE
// -------------------------------------------------------------
async function checkAndSendVipReminders() {
  if (!activeSock || !isBotConnected) return;

  try {
    const trackingMap = getOrderTrackingMap();
    const now = Date.now();
    let isMapUpdated = false;

    for (const orderId in trackingMap) {
      const order = trackingMap[orderId];
      if (!order || !order.phone) continue;

      // 1. Agar buyer ne already token money pay kar di hai, toh REMINDER KABHI NAHI JAYEGA!
      if (order.paidVip) {
        continue;
      }

      // 2. Agar reminder already send ho chuka hai, dubara spam na karein
      if (order.reminderSent) {
        continue;
      }

      const orderTime = new Date(order.createdAt).getTime();
      const ageHours = (now - orderTime) / (1000 * 60 * 60);

      // 3 se 5 ghante ke beech reminder bhejein
      if (ageHours >= 3 && ageHours <= 5) {
        const cleanPhone = String(order.phone).replace(/[^0-9]/g, "").slice(-10);
        if (cleanPhone.length !== 10) continue;

        const jid = `91${cleanPhone}@s.whatsapp.net`;
        const remainingCod = Math.max(0, (order.totalAmount || 0) - 50);
        const directUpiLink = `upi://pay?pa=9555247659@paytm&pn=YouthUp&am=50&tn=VIP_${order.orderId}`;
        const payWebUrl = `https://youthup.in/pay?id=${order.orderId}`;

        const reminderMsg =
`⏰ *REMINDER: VIP Priority Dispatch Offer - YouthUp Store*

Namaste ${order.customerName || "Ji"}!
Aapka Order #${order.orderId} (${order.productTitle || "Product"}) warehouse packing station par ready hai.

⚡ *Fast Delivery & Special Discount:*
Agar aap sirf *₹50 Advance Token* pay karte hain toh delivery boy ko parcel milne par Flat ₹50 KAM (sirf *₹${remainingCod}*) COD dena hoga aur parcel *Superfast VIP Priority* se dispatch hoga!

🔘 *[ ⚡ PAY ₹50 VIP TOKEN ]*
👉 Direct UPI App: (Direct UPI App: ${directUpiLink})
👉 1-Click Pay Link: ${payWebUrl}
👉 Ya bas *50* reply karein.

🔘 *[ 📍 TRACK ORDER ]*
👉 Order live track karne ke liye *TRACK* reply karein.

_(Agar aap normal Cash on Delivery hi chahte hain toh reply na karein, parcel jald deliver hoga)_ 🙏`;

        try {
          await activeSock.sendMessage(jid, { text: reminderMsg });
          order.reminderSent = true;
          isMapUpdated = true;
          console.log(`⏰ [VIP REMINDER SENT] 3-4hr token reminder sent for #${order.orderId} to +91${cleanPhone}`);
        } catch (sendErr) {
          console.error(`Failed to dispatch reminder to ${jid}:`, sendErr.message);
        }
      }
    }

    if (isMapUpdated) {
      saveOrderTrackingMap(trackingMap);
    }
  } catch (err) {
    console.error("Error in checkAndSendVipReminders:", err);
  }
}

// Run VIP Reminder check every 5 minutes
setInterval(checkAndSendVipReminders, 5 * 60 * 1000);

// -------------------------------------------------------------
// 24x7 CLOUD ORDER WATCHER: Automatic order alerts on new orders
// -------------------------------------------------------------
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
  if (!activeSock || !isBotConnected) return;

  try {
    const res = await fetch("https://youthup.in/api/orders");
    const data = await res.json();
    if (!data.success || !Array.isArray(data.orders)) return;

    const sentList = getSentAlerts();
    const trackingMap = getOrderTrackingMap();

    for (const order of data.orders) {
      if (!order.orderId || sentList.includes(order.orderId)) {
        continue;
      }

      // 1. Agar order already confirmed ya dispatched hai, toh dubara alert bilkul na jaye
      if (order.status && order.status !== "PENDING_CONFIRMATION") {
        markAlertSent(order.orderId);
        continue;
      }

      // 2. Sirf taze orders ko alert bhejein (last 20 minutes)
      if (order.createdAt) {
        const orderAgeMinutes = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60);
        if (orderAgeMinutes > 20) {
          markAlertSent(order.orderId);
          continue;
        }
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

      // Save order in tracking map for 3-4hr reminders
      trackingMap[order.orderId] = {
        orderId: order.orderId,
        phone: cleanPhone,
        customerName: order.customer?.name || "Customer",
        productTitle: order.item?.title || "YouthUp Product",
        totalAmount: order.item?.totalAmount || 0,
        createdAt: order.createdAt || new Date().toISOString(),
        paidVip: order.paymentStatus === "PAID" || order.paymentStatus === "VIP_TOKEN_PAID",
        reminderSent: false
      };
      saveOrderTrackingMap(trackingMap);

      // Clean Button-Style Action Prompts
      const messageText = 
`🎉 *Namaste ${order.customer?.name || "Customer"} Ji!*
YouthUp Store se aapka order successfully book ho gaya hai.

📦 *Order ID:* ${order.orderId}
🏷️ *Product:* ${order.item?.title || "YouthUp Product"}
💰 *Total Amount:* Rs. ${order.item?.totalAmount || 0} (${order.paymentMethod || "Cash on Delivery"})
📍 *Delivery Address:* ${order.customer?.address || ""}, ${order.customer?.city || ""} - ${order.customer?.pincode || ""}

---
🔘 *[ ✅ CONFIRM ORDER ]*
Order confirm karne ke liye bas *1* ya *CONFIRM* reply karein.

🔘 *[ ⚡ PAY ₹50 VIP TOKEN (FAST DELIVERY) ]*
Agar aap *Rs 50 advance token* UPI se pay karte hain:
• Parcel aaj hi Superfast VIP Priority se dispatch hoga
• Delivery ke waqt Flat Rs 50 KAM (sirf *Rs. ${remainingCod}*) COD dena hoga
• Token pay karne ke liye bas *50* reply karein

---
🚚 *Delivery Time:* 3-5 working days.
📍 *Order kahan tak pahucha janne ke liye:* Bas *TRACK* reply karein.

Shukriya! Team YouthUp 🙏
*YouthUp Helpline: +91 95552 47659*`;

      try {
        recordContactedCustomer(cleanPhone);
        await activeSock.sendMessage(jid, { text: messageText });
        console.log(`\n🚀 [AUTO-ALERT SENT] Order #${order.orderId} successfully sent on WhatsApp to +91${cleanPhone}!`);
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

// -------------------------------------------------------------
// 🌐 HTTP SERVER (PORT 5005 / RENDER PORT)
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
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
        recordContactedCustomer(cleanPhone);

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

// 24x7 Cloud Self-Ping (Prevents Render free tier from sleeping)
if (process.env.RENDER_EXTERNAL_URL) {
  console.log("⚡ Render 24x7 Self-Ping Keepalive registered for:", process.env.RENDER_EXTERNAL_URL);
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/status`).catch(() => {});
  }, 10 * 60 * 1000);
}

startWhatsAppBot().catch(console.error);
