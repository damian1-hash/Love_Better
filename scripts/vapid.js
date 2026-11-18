// Prints a new pair of VAPID keys for push notifications.
// Add both to your Vercel project's Environment Variables, then redeploy.
import { generateVapidKeys } from "../src/push.js";
const k = generateVapidKeys();
console.log("VAPID_PUBLIC_KEY=" + k.publicKey);
console.log("VAPID_PRIVATE_KEY=" + k.privateKey);
