export interface OfflinePageContext {
  label: string;
  name: string;
  port: number;
  lastSeen?: string;
}

const RETRY_SECONDS = 5;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatLastSeen(lastSeen: string | undefined): string {
  if (typeof lastSeen !== "string" || lastSeen.length === 0) {
    return "Never";
  }

  const parsed = new Date(lastSeen);
  if (Number.isNaN(parsed.valueOf())) {
    return "Never";
  }

  return parsed.toISOString();
}

export function renderOfflinePage(context: OfflinePageContext): string {
  const label = escapeHtml(context.label);
  const name = escapeHtml(context.name);
  const port = `${context.port}`;
  const lastSeen = escapeHtml(formatLastSeen(context.lastSeen));

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `  <meta http-equiv="refresh" content="${RETRY_SECONDS}">`,
    `  <title>${label} offline</title>`,
    "  <style>",
    "    :root {",
    "      color-scheme: light;",
    "      font-family: \"Segoe UI\", \"Helvetica Neue\", Helvetica, Arial, sans-serif;",
    "    }",
    "    body {",
    "      margin: 0;",
    "      min-height: 100vh;",
    "      display: grid;",
    "      place-items: center;",
    "      background: #f8fafc;",
    "      color: #0f172a;",
    "    }",
    "    main {",
    "      width: min(560px, 100vw - 2rem);",
    "      box-sizing: border-box;",
    "      padding: 1.5rem;",
    "      background: #ffffff;",
    "      border: 1px solid #dbe4f0;",
    "      border-radius: 12px;",
    "      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);",
    "    }",
    "    h1 {",
    "      margin: 0 0 0.5rem;",
    "      font-size: 1.35rem;",
    "    }",
    "    p {",
    "      margin: 0.5rem 0;",
    "    }",
    "    dl {",
    "      display: grid;",
    "      grid-template-columns: max-content 1fr;",
    "      gap: 0.4rem 0.75rem;",
    "      margin: 1rem 0;",
    "    }",
    "    dt {",
    "      color: #475569;",
    "      font-weight: 600;",
    "    }",
    "    dd {",
    "      margin: 0;",
    "      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace;",
    "      word-break: break-word;",
    "    }",
    "    .meta {",
    "      color: #64748b;",
    "      font-size: 0.95rem;",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    `    <h1>${label} is offline</h1>`,
    "    <p>The backend is currently unavailable.</p>",
    "    <dl>",
    `      <dt>${label}</dt><dd>${name}</dd>`,
    "      <dt>Port</dt><dd>" + escapeHtml(port) + "</dd>",
    `      <dt>Last seen</dt><dd>${lastSeen}</dd>`,
    "    </dl>",
    `    <p class="meta">Retrying every ${RETRY_SECONDS} seconds.</p>`,
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
}
