import axios from "axios";
import crypto from "crypto";
import https from "https";

const API_URL = "https://api.coinstore.com/api/v2/trade/order/active";
const API_KEY = process.env.COINSTORE_API_KEY || "your_api_key";
const SECRET_KEY = process.env.COINSTORE_SECRET_KEY || "your_secret_key";
const SYMBOL = "polusdt";

function generateSignature(secretKey, payload = "") {
  const expires = Date.now();
  const expiresKey = Math.floor(expires / 30000).toString();

  const firstKey = crypto
    .createHmac("sha256", secretKey)
    .update(expiresKey)
    .digest("hex");

  const signature = crypto
    .createHmac("sha256", Buffer.from(firstKey, "utf-8"))
    .update(payload)
    .digest("hex");

  return { expires, signature };
}

async function fetchOrders() {
  const payload = `symbol=${SYMBOL.toLowerCase()}`;
  const { expires, signature } = generateSignature(SECRET_KEY, payload);

  const headers = {
    "X-CS-APIKEY": API_KEY,
    "X-CS-EXPIRES": expires.toString(),
    "X-CS-SIGN": signature,
    "Content-Type": "application/x-www-form-urlencoded",

    // ✅ Browser-like headers (bypass Cloudflare bot check)
   "User-Agent": "PostmanRuntime/7.36.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.coinstore.com",
    Referer: "https://www.coinstore.com/",
  };

  const httpsAgent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: true, // ensure SSL validation
  });

  try {
    console.log("🚀 Fetching active orders...");
    const response = await axios.post(API_URL, payload, {
      headers,
      httpsAgent,
      timeout: 15000,
    });

    console.log("✅ Response code:", response.status);
    console.log("📦 Data:", response.data);
  } catch (err) {
    console.error("❌ Request failed:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Body:", err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

fetchOrders();
