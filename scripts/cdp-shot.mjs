// Capture a PNG of a WebView2 page over CDP, at the page's own pixel size.
// Usage: node scripts/cdp-shot.mjs <pageIdSubstring> <outFile>
import { writeFileSync } from "node:fs";

const [, , needle, out] = process.argv;
const port = process.env.CDP_PORT || "9222";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = (needle || "").startsWith("^")
  ? targets.find((t) => (t.url || "") === needle.slice(1))
  : targets.find((t) => (t.url || "").includes(needle ?? ""));
if (!page) {
  console.error("no target matching", needle, "->", targets.map((t) => t.url));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
});

const { data } = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(data, "base64"));
console.log("saved", out);
ws.close();
