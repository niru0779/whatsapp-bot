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
// ðŸ”’ PRIVACY WHITELIST: Sirf wahi numbers jinhe website se message gaya ho
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
// âš™ï¸ STORE SETTINGS SYNC (CMS Dynamic Full Pay Discount & VIP Token)
// -------------------------------------------------------------
let storeSettings = {
  vipFastAmount: 50,
  fullPayDiscount: 100,
  upiId: "9555247659@paytm",
  upiName: "YouthUp"
};

async function syncStoreSettings() {
  try {
    const res = await fetch("https://youthup.in/api/settings");
    const data = await res.json();
    if (data && data.success && data.settings) {
      if (data.settings.vipFastAmount !== undefined) {
        storeSettings.vipFastAmount = Number(data.settings.vipFastAmount) || 50;
      }
      if (data.settings.fullPayDiscount !== undefined) {
        storeSettings.fullPayDiscount = Number(data.settings.fullPayDiscount) || 100;
      }
      if (data.settings.upiId) storeSettings.upiId = data.settings.upiId;
      if (data.settings.upiName) storeSettings.upiName = data.settings.upiName;
      console.log(`âš™ï¸ [CMS SETTINGS SYNC] VIP Token: â‚¹${storeSettings.vipFastAmount} | Full Pay Discount: â‚¹${storeSettings.fullPayDiscount}`);
    }
  } catch (e) {}
}

syncStoreSettings();
setInterval(syncStoreSettings, 2 * 60 * 1000); // Har 2 minute me CMS settings sync karein

// -------------------------------------------------------------
// ðŸ“¦ ORDER TRACKING & VIP ADVANCE STATE HELPERS
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
    console.log(`ðŸ“‹ [CUSTOMER SYNC] Total ${contactedCustomers.size} verified store numbers loaded into auto-reply whitelist.`);
  } catch (err) {
    // Offline or retry
  }
}

loadContactedCustomers();
syncStoreCustomers();
setInterval(syncStoreCustomers, 5 * 60 * 1000);

// -------------------------------------------------------------
// ðŸ¤– WHATSAPP CLIENT INITIALIZATION & MESSAGE HANDLING
// -------------------------------------------------------------
async function startWhatsAppBot() {
  console.log("==================================================");
  console.log("ðŸ¤– YouthUp Real WhatsApp Auto-Reply Bot Starting...");
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
        console.log("\nðŸ“² [ACTION REQUIRED] QR Code ready in Website Admin Panel!");
        console.log("ðŸ‘‰ youthup.in/admin > Tab 5 (WhatsApp Bot) par scan karein");
      } catch (e) {
        console.error("QR image error:", e);
      }
    }

    if (connection === "close") {
      isBotConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("âš ï¸ Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppBot();
      }
    } else if (connection === "open") {
      isBotConnected = true;
      currentQrDataUrl = null;
      console.log("\nâœ… ==================================================");
      console.log("ðŸŽ‰ WHATSAPP BOT CONNECTED SUCCESSFULLY!");
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

      // 1. ðŸ›‘ GROUPS & BROADCASTS KO BILKUL IGNORE KAREIN
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

      // 1. Buyer wants to Pay â‚¹50 Token ("50", "token", "advance kaise du")
      const isVipTokenRequest =
        lower === "50" ||
        lower === "token" ||
        lower === "advance" ||
        lower.includes("50 kaise") ||
        lower.includes("token kaise") ||
        lower.includes("advance kaise");

      // 1.5 Buyer wants FULL PAYMENT / CMS DISCOUNT ("full", "100", "full payment", "online payment")
      const isFullPaymentIntent =
        lower === "full" ||
        lower === "100" ||
        lower.includes("full payment") ||
        lower.includes("full pay") ||
        lower.includes("online payment") ||
        lower.includes("discount") ||
        lower.includes("pura payment") ||
        lower.includes("chhoot");

      // 2. Buyer has PAID / Sent Screenshot
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
        isFullPaymentIntent ||
        isVipPaymentDone ||
        isWebsiteOrderClick ||
        isAddressDetails;

      // ðŸ›‘ STRICT PRIVACY RULE:
      // Agar na toh yeh koi order action hai, aur na hi yeh kisi verified store customer ka sawaal hai:
      // TOH KISI BHI PERSONAL CHAT / BANK / FRIEND / FAMILY KO BILKUL REPLY NAHI JAYEGA!
      if (!isKnownCustomerAction && !isContactedCustomer) {
        console.log(`â­ï¸ [SKIPPED NON-CUSTOMER / PERSONAL CHAT] ${senderPhone}: "${text}"`);
        return;
      }

      // Customer ko whitelist me record karein
      recordContactedCustomer(senderPhone);
      console.log(`ðŸ“© [VERIFIED CUSTOMER] ${senderPhone}: "${text}"`);

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
          `ðŸ“ *Aapka Live Order Tracker Link:*\n\n` +
          `ðŸ‘‰ ${trackUrl}\n\n` +
          `ðŸ“¦ *Order ID:* ${orderId || "Latest Order"}\n` +
          `ðŸšš *Courier Partner:* Delhivery / BlueDart Express\n` +
          `â±ï¸ *Expected Delivery:* 3-5 Working Days\n\n` +
          `Upar diye link par click karke aap parcel ki live location dekh sakte hain. Dhanyawad! ðŸ™`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Replied Tracking Link to ${senderPhone}`);
        return;
      }

      // 2. BUYER REPLIED "FULL" / "100" (Full Payment with Flat Discount from CMS)
      if (isFullPaymentIntent) {
        const orderId = customerOrder?.orderId || "YU-ORDER";
        const totalAmt = customerOrder?.totalAmount || 0;
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const fullDiscountAmt = Math.max(0, totalAmt - fullDiscount);
        const payWebUrl = `https://youthup.in/pay?id=${orderId}&mode=full&am=${fullDiscountAmt}`;

        const replyText =
          `ðŸŽ *SUPER SAVER OFFER - FLAT â‚¹${fullDiscount} INSTANT DISCOUNT!*\n\n` +
          `Aapke order par Flat â‚¹${fullDiscount} instant discount lag gaya hai:\n` +
          (totalAmt > 0 ? `â€¢ Asli Price: Rs. ${totalAmt}\n` : "") +
          `â€¢ Online Discount: -Rs. ${fullDiscount}\n` +
          (fullDiscountAmt > 0 ? `â€¢ *Aapko Pay Karna Hai: Sirf Rs. ${fullDiscountAmt}*\n\n` : `â€¢ *Flat â‚¹${fullDiscount} Discount Lag Gaya Hai!*\n\n`) +
          `ðŸ”˜ *[ âš¡ 1-CLICK PAY VIA UPI (SAVE â‚¹${fullDiscount}) ]*\n` +
          `ðŸ‘‰ ${payWebUrl}\n` +
          `_(Link click karte hi PhonePe / GPay / Paytm seedha khul jayega)_\n\n` +
          `ðŸ“± *Manual UPI Details:*\n` +
          `â€¢ UPI ID: ${storeSettings.upiId || "9555247659@paytm"}\n` +
          `â€¢ Name: ${storeSettings.upiName || "YouthUp"}\n` +
          `â€¢ Amount: Rs. ${fullDiscountAmt > 0 ? fullDiscountAmt : `Total - ${fullDiscount}`}\n` +
          `â€¢ Note: FULL_${orderId}\n\n` +
          `âœ… *Pay karne ke baad yahan SCREENSHOT ya "PAID" bhej dein.*\n\n` +
          `âš¡ *Fayde:*\n` +
          `1. Flat â‚¹${fullDiscount} ki sidhi bachat!\n` +
          `2. Delivery par Zero (Rs. 0) Cash dena hoga.\n` +
          `3. Parcel aaj hi Superfast VIP Priority se dispatch hoga!`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Sent Full Payment Discount Instructions to ${senderPhone}`);
        return;
      }

      // 3. PAYMENT DONE ("paid", "screenshot", "advance bhej diya")
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
          `ðŸ‘‘ *YOUTHUP VIP CUSTOMER - FAST DELIVERY ACTIVATED!*\n\n` +
          `ðŸŽ‰ *Shukriya! Aapka Payment Receive Ho Gaya Hai.*\n\n` +
          `âš¡ *Delivery Status:* Superfast VIP Priority Dispatch Queue\n` +
          `ðŸ“¦ Hamari warehouse team aapka parcel aaj hi Delhivery/BlueDart express se dispatch kar rahi hai.\n\n` +
          `ðŸ’° *Updated Balance Details:*\n` +
          (totalAmt > 0 ? `â€¢ Total Order Amount: Rs. ${totalAmt}\n` : "") +
          `â€¢ Online Payment Received: Done\n` +
          (remainingCod > 0 ? `â€¢ *Delivery Boy Ko Dene Honge: Sirf Rs. ${remainingCod} (Remaining COD)*\n\n` : `â€¢ *Zero Payment at Delivery (Full Paid)*\n\n`) +
          `ðŸ“ *Order Tracking:* Parcel live track karne ke liye bas *TRACK* likhkar bhejein.\n\n` +
          `YouthUp Store par bharosa karne ke liye dil se dhanyawad! ðŸ™`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Replied VIP Customer Confirmation to ${senderPhone}`);
        return;
      }

      // 4. BUYER REPLIED "50" (Wants to pay VIP advance token)
      if (isVipTokenRequest) {
        const orderId = customerOrder?.orderId || "YU-ORDER";
        const totalAmt = customerOrder?.totalAmount || 0;
        const vipAmount = storeSettings.vipFastAmount || 50;
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const remainingCod = Math.max(0, totalAmt - vipAmount);
        const fullDiscountAmt = Math.max(0, totalAmt - fullDiscount);
        const payWebUrl = `https://youthup.in/pay?id=${orderId}&mode=advance&am=${vipAmount}`;
        const payFullUrl = `https://youthup.in/pay?id=${orderId}&mode=full&am=${fullDiscountAmt}`;

        const replyText =
          `âš¡ *â‚¹${vipAmount} Advance Token Payment (VIP Fast Delivery):*\n\n` +
          `Neeche diye gaye link par click karein, aapka PhonePe / Google Pay / Paytm 1-Tap me open ho jayega:\n\n` +
          `ðŸ”˜ *[ âš¡ 1-CLICK PAY â‚¹${vipAmount} VIA UPI ]*\n` +
          `ðŸ‘‰ ${payWebUrl}\n` +
          `_(Link click karte hi aapke phone ka UPI App khul jayega)_\n\n` +
          `ðŸ“± *Manual UPI Details:*\n` +
          `â€¢ UPI ID: ${storeSettings.upiId || "9555247659@paytm"}\n` +
          `â€¢ Account Name: ${storeSettings.upiName || "YouthUp"}\n` +
          `â€¢ Amount: Rs. ${vipAmount}\n` +
          `â€¢ Note: VIP_${orderId}\n\n` +
          `âš¡ *Fayde:*\n` +
          `1. Parcel aaj hi VIP Priority se express courier se dispatch hoga.\n` +
          (remainingCod > 0
            ? `2. Delivery ke waqt flat Rs. ${vipAmount} KAM (sirf *Rs. ${remainingCod}*) COD dena hoga!\n\n`
            : `2. Delivery ke waqt flat Rs. ${vipAmount} KAM COD dena hoga!\n\n`) +
          `ðŸŽ *SPECIAL OFFER: Pura payment abhi online karne par FLAT â‚¹${fullDiscount} DISCOUNT!* (Sirf Rs. ${fullDiscountAmt > 0 ? fullDiscountAmt : `Total - ${fullDiscount}`})\n` +
          `ðŸ‘‰ Full Pay Link: ${payFullUrl} (Ya *FULL* reply karein)`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Sent VIP Token UPI Instructions to ${senderPhone}`);
        return;
      }

      // 5. BUYER REPLIED "1" / "CONFIRM"
      if (isConfirmIntent) {
        try {
          fetch("https://youthup.in/api/orders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customerPhone: senderPhone, status: "CONFIRMED" })
          }).catch(() => {});
        } catch (e) {}

        const orderId = customerOrder?.orderId || "";
        const totalAmt = customerOrder?.totalAmount || 0;
        const vipAmount = storeSettings.vipFastAmount || 50;
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const fullDiscountAmt = Math.max(0, totalAmt - fullDiscount);

        const replyText =
          `ðŸŽ‰ *Aapka Order Successfully CONFIRM Ho Gaya Hai!*\n\n` +
          `âœ… *Status:* Locked in Warehouse Packaging Queue\n` +
          `ðŸ“¦ Hamari team aapka parcel pack karke Delhivery/BlueDart express se dispatch kar rahi hai.\n` +
          `ðŸšš *Delivery Time:* 3-4 Business Days mein aapke address par deliver ho jayega.\n\n` +
          `ðŸ”˜ *2 Exciting Offers Available:*\n` +
          `1ï¸âƒ£ *â‚¹${vipAmount} Advance Token:* Aaj hi VIP Priority se dispatch hoga aur delivery par â‚¹${vipAmount} kam COD dena hoga. (Reply *50*)\n` +
          `2ï¸âƒ£ *Full Online Payment:* Abhi online pay karne par *FLAT â‚¹${fullDiscount} DISCOUNT* milega (Sirf Rs. ${fullDiscountAmt > 0 ? fullDiscountAmt : `Total - ${fullDiscount}`})! (Reply *FULL*)\n\n` +
          `Shukriya! Team YouthUp ðŸ™`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Auto-replied Order Confirmation to ${senderPhone}`);
        return;
      }

      // 6. WEBSITE ORDER CLICK (Initiated from website WhatsApp button)
      if (isWebsiteOrderClick) {
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const replyText =
          `Namaste! ðŸ™ *YouthUp Smart Store* se order karne ke liye bohot shukriya.\n\n` +
          `Aapka order receive ho gaya hai! Kripya apna *Delivery Address* neeche diye format mein bhejein taaki hum turant parcel dispatch kar sakein:\n\n` +
          `ðŸ‘¤ *1. Pura Naam:*\n` +
          `ðŸ  *2. Makaan No / Gali / Colony:*\n` +
          `ðŸ“ *3. Shahar (City) & State:*\n` +
          `ðŸ“® *4. Pincode (6 Digits):*\n\n` +
          `ðŸšš *Payment:* 100% Free Cash on Delivery (COD) - Paisa parcel milne par dein.\n` +
          `ðŸŽ *Special Offer:* Abhi online full pay karne par *FLAT â‚¹${fullDiscount} DISCOUNT* milega!`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Auto-replied with Order Confirmation Form to ${senderPhone}`);
        return;
      }

      // 7. CUSTOMER SENT ADDRESS DETAILS
      if (isAddressDetails) {
        const vipAmount = storeSettings.vipFastAmount || 50;
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const replyText =
          `ðŸŽ‰ *Aapki Delivery Details Mil Gayi Hain!*\n\n` +
          `Aapka Cash on Delivery order successfully confirm kar diya gaya hai.\n\n` +
          `ðŸ“¦ *Status:* Ready for Warehouse Dispatch\n` +
          `ðŸšš *Delivery:* 3-5 Din mein parcel aapke ghar deliver ho jayega.\n\n` +
          `ðŸ”˜ *[ ðŸŽ SPECIAL DISCOUNT OFFERS ]*\n` +
          `â€¢ Rs. ${vipAmount} Advance Token dene par Fast VIP delivery (Reply *50*)\n` +
          `â€¢ Full online pay karne par *FLAT â‚¹${fullDiscount} DISCOUNT* (Reply *FULL*)\n\n` +
          `Thank you for shopping with *YouthUp Store*! ðŸ™`;

        await sock.sendMessage(sender, { text: replyText });
        console.log(`ðŸ¤– Auto-replied Address Confirmation to ${senderPhone}`);
        return;
      }

      // 8. COD INQUIRY (Verified store customers only)
      if (isPaymentInquiry && isContactedCustomer) {
        const vipAmount = storeSettings.vipFastAmount || 50;
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const replyText =
          `ðŸ’µ *100% Free Cash on Delivery (COD)!*\n\n` +
          `Aapko pehle 1 rupaya bhi dene ki zaroorat nahi hai. Parcel ghar pahunchne par cash dein ya delivery boy ke scanner par UPI karein.\n\n` +
          `ðŸŽ *Online Payment Offers:*\n` +
          `1. Rs. ${vipAmount} Token dene par delivery par Rs ${vipAmount} kam dena hoga aur parcel aaj hi VIP Priority se jayega (Reply *50*)\n` +
          `2. Full payment online karne par *FLAT â‚¹${fullDiscount} DISCOUNT* milega! (Reply *FULL*)`;

        await sock.sendMessage(sender, { text: replyText });
        return;
      }

      // 9. GENERIC GREETING (Hi/Hello - Verified store customers only)
      if ((lower === "hi" || lower === "hello" || lower === "namaste" || lower === "help") && isContactedCustomer) {
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const replyText =
          `Namaste! ðŸ™ *YouthUp Smart Store* mein aapka swagat hai.\n\n` +
          `Main aapki kya sahayata kar sakta hoon?\n\n` +
          `ðŸ”˜ *[ âœ… CONFIRM ORDER ]* âž” Reply *1*\n` +
          `ðŸ”˜ *[ âš¡ VIP FAST DELIVERY ]* âž” Reply *50*\n` +
          `ðŸ”˜ *[ ðŸŽ FULL PAY FLAT â‚¹${fullDiscount} OFF ]* âž” Reply *FULL*\n` +
          `ðŸ”˜ *[ ðŸ“ TRACK ORDER ]* âž” Reply *TRACK*\n\n` +
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
// â° AUTOMATED 3-4 HOUR VIP REMINDER ENGINE
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

      if (order.paidVip) {
        continue;
      }

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
        const totalAmt = order.totalAmount || 0;
        const vipAmount = storeSettings.vipFastAmount || 50;
        const fullDiscount = storeSettings.fullPayDiscount ?? 100;
        const remainingCod = Math.max(0, totalAmt - vipAmount);
        const fullDiscountAmt = Math.max(0, totalAmt - fullDiscount);
        const payWebUrl = `https://youthup.in/pay?id=${order.orderId}&mode=advance&am=${vipAmount}`;
        const payFullUrl = `https://youthup.in/pay?id=${order.orderId}&mode=full&am=${fullDiscountAmt}`;

        const reminderMsg =
`â° *REMINDER: VIP Priority & Special Discount Offers - YouthUp Store*

Namaste ${order.customerName || "Ji"}!
Aapka Order #${order.orderId} (${order.productTitle || "Product"}) warehouse packing station par ready hai.

âš¡ *OFFER 1: Pay â‚¹${vipAmount} VIP Advance Token*
â€¢ Delivery boy ko parcel milne par Flat â‚¹${vipAmount} KAM (sirf *Rs. ${remainingCod}*) COD dena hoga.
ðŸ‘‰ Bas *50* reply karein ya pay karein: ${payWebUrl}

ðŸŽ *OFFER 2: Full Payment Par FLAT â‚¹${fullDiscount} DISCOUNT!*
â€¢ Total Rs. ${totalAmt} ki jagah sirf *Rs. ${fullDiscountAmt}* pay karein aur payein Flat â‚¹${fullDiscount} Discount! Delivery par Rs 0 dena hoga.
ðŸ‘‰ *1-Click Pay Rs. ${fullDiscountAmt}:* ${payFullUrl}
ðŸ‘‰ Ya bas *FULL* ya *100* reply karein.

ðŸ”˜ *[ ðŸ“ TRACK ORDER ]*
ðŸ‘‰ Order live track karne ke liye *TRACK* reply karein.

_(Agar aap normal Cash on Delivery hi chahte hain toh reply na karein, parcel jald deliver hoga)_ ðŸ™`;

        try {
          await activeSock.sendMessage(jid, { text: reminderMsg });
          order.reminderSent = true;
          isMapUpdated = true;
          console.log(`â° [VIP REMINDER SENT] 3-4hr token reminder sent for #${order.orderId} to +91${cleanPhone}`);
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

      if (order.status && order.status !== "PENDING_CONFIRMATION") {
        markAlertSent(order.orderId);
        continue;
      }

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
      const totalAmt = order.item?.totalAmount || 0;
      const vipAmount = storeSettings.vipFastAmount || 50;
      const fullDiscount = storeSettings.fullPayDiscount ?? 100;
      const remainingCod = Math.max(0, totalAmt - vipAmount);
      const fullDiscountAmt = Math.max(0, totalAmt - fullDiscount);
      const payFullUrl = `https://youthup.in/pay?id=${order.orderId}&mode=full&am=${fullDiscountAmt}`;

      // Save order in tracking map for 3-4hr reminders
      trackingMap[order.orderId] = {
        orderId: order.orderId,
        phone: cleanPhone,
        customerName: order.customer?.name || "Customer",
        productTitle: order.item?.title || "YouthUp Product",
        totalAmount: totalAmt,
        createdAt: order.createdAt || new Date().toISOString(),
        paidVip: order.paymentStatus === "PAID" || order.paymentStatus === "VIP_TOKEN_PAID",
        reminderSent: false
      };
      saveOrderTrackingMap(trackingMap);

      const messageText = 
`ðŸŽ‰ *Namaste ${order.customer?.name || "Customer"} Ji!*
YouthUp Store se aapka order successfully book ho gaya hai.

ðŸ“¦ *Order ID:* #${order.orderId}
ðŸ·ï¸ *Product:* ${order.item?.title || "YouthUp Product"}
ðŸ’° *Total Amount:* Rs. ${totalAmt} (${order.paymentMethod || "Cash on Delivery"})
ðŸ“ *Delivery Address:* ${order.customer?.address || ""}, ${order.customer?.city || ""} - ${order.customer?.pincode || ""}

---
Apne hisaab se payment option chunein:

ðŸ”˜ *1. [ âœ… CONFIRM COD ORDER ]*
â€¢ Paisa parcel milne par dein (Rs. ${totalAmt}).
âž” Bas *1* ya *CONFIRM* reply karein.

ðŸ”˜ *2. [ âš¡ PAY â‚¹${vipAmount} VIP TOKEN ]*
â€¢ Parcel aaj hi Superfast VIP Priority se dispatch hoga
â€¢ Delivery boy ko Rs ${vipAmount} KAM (sirf *Rs. ${remainingCod}*) COD dena hoga
âž” Bas *50* reply karein.

ðŸ”˜ *3. [ ðŸŽ FULL PAYMENT - FLAT â‚¹${fullDiscount} DISCOUNT ]*
â€¢ Abhi online pay karein aur payein *FLAT â‚¹${fullDiscount} DISCOUNT*!
â€¢ Aapko Rs. ${totalAmt} ki jagah sirf *Rs. ${fullDiscountAmt}* dena hoga! Delivery par Zero (Rs 0) Cash.
ðŸ‘‰ *1-Click Pay Rs. ${fullDiscountAmt}:* ${payFullUrl}
âž” Ya bas *FULL* ya *100* reply karein.

---
ðŸšš *Delivery Time:* 3-5 working days.
ðŸ“ *Order kahan tak pahucha janne ke liye:* Bas *TRACK* reply karein.

Shukriya! Team YouthUp ðŸ™
*YouthUp Helpline: +91 95552 47659*`;

      try {
        recordContactedCustomer(cleanPhone);
        await activeSock.sendMessage(jid, { text: messageText });
        console.log(`\nðŸš€ [AUTO-ALERT SENT] Order #${order.orderId} successfully sent on WhatsApp to +91${cleanPhone}!`);
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
console.log("ðŸ‘€ Cloud Order Watcher active: Checking https://youthup.in every 4 seconds for new orders!");

// -------------------------------------------------------------
// ðŸŒ HTTP SERVER (PORT 5005 / RENDER PORT)
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
        console.log(`ðŸš€ [OUTGOING WHATSAPP DISPATCH] Successfully sent order alert to ${jid}`);

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
    <div class="icon">ðŸŽ‰</div>
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
  console.log(`âš¡ Bot HTTP Alert Dispatcher listening on port ${PORT}`);
});

// 24x7 Cloud Self-Ping (Prevents Render free tier from sleeping)
if (process.env.RENDER_EXTERNAL_URL) {
  console.log("âš¡ Render 24x7 Self-Ping Keepalive registered for:", process.env.RENDER_EXTERNAL_URL);
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/status`).catch(() => {});
  }, 10 * 60 * 1000);
}

startWhatsAppBot().catch(console.error);
