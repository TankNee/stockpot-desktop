// Tiny CDP probe: evaluates an expression in a WebView2 page so we can read the
// live DOM instead of trusting screenshot pixels.
// Usage: node scripts/cdp-eval.mjs <pageIdSubstring> "<expression>"
//        node scripts/cdp-eval.mjs <pageIdSubstring> @probe.js
// Passing @file keeps multi-line expressions away from the shell's quoting rules.
import { readFileSync } from "node:fs";

const [, , needle, rawExpression] = process.argv;
const port = process.env.CDP_PORT || "9222";
const expression = rawExpression?.startsWith("@")
  ? readFileSync(rawExpression.slice(1), "utf8")
  : rawExpression;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = (needle || "").startsWith("^")
  ? targets.find((t) => (t.url || "") === needle.slice(1))
  : targets.find((t) => (t.url || "").includes(needle ?? ""));
if (!page) {
  console.error("no target matching", needle, "->", targets.map((t) => t.url));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const done = new Promise((resolve, reject) => {
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== 1) return;
    resolve(msg);
    ws.close();
  });
  ws.addEventListener("error", (event) => reject(event.error ?? new Error("ws error")));
  setTimeout(() => reject(new Error("timeout")), 8000);
});

try {
  const msg = await done;
  const result = msg.result?.result;
  console.log(JSON.stringify(result?.value ?? result, null, 2));
} catch (err) {
  console.error("probe failed:", err.message);
  process.exit(1);
}
