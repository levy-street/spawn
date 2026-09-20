import { Script } from "node:vm";

/** Bundled xterm contains HTML strings of its own. Insert after the actual
 * document scripts, never into the first closing-body text in a vendor string. */
export function instrumentWorkerHtml(html, headScript, bodyScript) {
  const head = html.indexOf("</head>");
  const body = html.lastIndexOf("</body>");
  if (head < 0 || body <= head) throw new Error("Worker document boundaries are missing.");
  const instrumented = `${html.slice(0, head)}<script>${headScript}</script>${html.slice(head, body)}<script>${bodyScript}</script>${html.slice(body)}`;
  const scripts = [...instrumented.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 3) throw new Error("Unexpected worker script boundaries.");
  // Fail before a native build, instead of discovering a dead WebView at runtime.
  for (const [, source] of scripts) new Script(source);
  return instrumented;
}
