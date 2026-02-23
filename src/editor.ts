function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type EditorMode = "markdown-editor" | "code-editor";

export function getEditorMode(filename: string): EditorMode {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith(".md") || normalized.endsWith(".mdx")) {
    return "markdown-editor";
  }

  return "code-editor";
}

export function generateCodeEditorHtml(filename: string, readonly: boolean): string {
  const escapedFilename = escapeHtml(filename);
  const filenameJson = JSON.stringify(filename);
  const readonlyJson = readonly ? "true" : "false";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapedFilename}</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#1D1D1D">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      background: #1D1D1D;
      color: #E8E8E3;
      font-family: "Avenir Next", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      -webkit-text-size-adjust: 100%;
    }
    #app {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    #editor-container {
      flex: 1;
      overflow: hidden;
      padding-bottom: 44px;
    }
    #editor {
      width: 100%;
      height: 100%;
    }
    .cm-editor {
      height: 100%;
      background: #1D1D1D;
    }
    .cm-scroller {
      font-family: "SF Mono", Monaco, "Cascadia Code", "Fira Code", monospace;
      font-size: 14px;
      line-height: 1.55;
      color: #E8E8E3;
    }
    .cm-focused { outline: none !important; }
    #status {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      min-height: 36px;
      background: rgba(24, 24, 24, 0.88);
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      border-top: 0.5px solid rgba(255, 255, 255, 0.06);
      color: rgba(232, 232, 227, 0.55);
      font-family: "Avenir Next", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      font-size: 12px;
      z-index: 50;
    }
    #status-text { white-space: nowrap; }
    #status-filename {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 12px;
    }
    #status.saving #status-text { color: rgba(232, 168, 56, 0.8); }
    #status.saved #status-text { color: rgba(217, 84, 79, 0.7); }
    #status.readonly #status-text { color: rgba(232, 232, 227, 0.75); }
  </style>
  <script type="importmap">
  {
    "imports": {
      "@codemirror/state": "https://esm.sh/@codemirror/state?bundle",
      "@codemirror/view": "https://esm.sh/@codemirror/view?bundle",
      "@codemirror/commands": "https://esm.sh/@codemirror/commands?bundle",
      "@codemirror/language": "https://esm.sh/@codemirror/language?bundle",
      "@codemirror/lang-javascript": "https://esm.sh/@codemirror/lang-javascript?bundle",
      "@codemirror/lang-json": "https://esm.sh/@codemirror/lang-json?bundle",
      "@codemirror/lang-html": "https://esm.sh/@codemirror/lang-html?bundle",
      "@codemirror/lang-css": "https://esm.sh/@codemirror/lang-css?bundle",
      "@codemirror/lang-markdown": "https://esm.sh/@codemirror/lang-markdown?bundle",
      "@codemirror/lang-python": "https://esm.sh/@codemirror/lang-python?bundle",
      "@codemirror/lang-yaml": "https://esm.sh/@codemirror/lang-yaml?bundle",
      "@codemirror/theme-one-dark": "https://esm.sh/@codemirror/theme-one-dark?bundle"
    }
  }
  </script>
</head>
<body>
  <div id="app">
    <div id="editor-container">
      <div id="editor"></div>
    </div>
    <div id="status">
      <span id="status-filename">${escapedFilename}</span>
      <span id="status-text">Loading...</span>
    </div>
  </div>

  <script type="module">
    import { EditorState } from "@codemirror/state";
    import { EditorView, drawSelection, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
    import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
    import { javascript } from "@codemirror/lang-javascript";
    import { json } from "@codemirror/lang-json";
    import { html as htmlLanguage } from "@codemirror/lang-html";
    import { css } from "@codemirror/lang-css";
    import { markdown } from "@codemirror/lang-markdown";
    import { python } from "@codemirror/lang-python";
    import { yaml } from "@codemirror/lang-yaml";
    import { oneDark } from "@codemirror/theme-one-dark";

    const FILE_NAME = ${filenameJson};
    const READONLY = ${readonlyJson};
    const SAVE_DEBOUNCE_MS = 1000;

    let editorView = null;
    let ws = null;
    let saveTimeout = null;
    let socketConnected = false;

    const statusEl = document.getElementById("status");
    const statusFilename = document.getElementById("status-filename");
    const statusText = document.getElementById("status-text");

    statusFilename.textContent = FILE_NAME;
    document.title = FILE_NAME;

    function updateStatus(text, cls) {
      statusText.textContent = text;
      statusEl.className = cls || "";
    }

    function resolveSharePrefix() {
      const match = window.location.pathname.match(/^\\/s\\/([A-Za-z0-9_-]+)/);
      if (!match) {
        return "";
      }
      return "/s/" + match[1];
    }

    function resolveLanguageExtension(name) {
      const lower = name.toLowerCase();
      if (lower.endsWith(".ts")) return javascript({ typescript: true });
      if (lower.endsWith(".tsx")) return javascript({ typescript: true, jsx: true });
      if (lower.endsWith(".js")) return javascript();
      if (lower.endsWith(".jsx")) return javascript({ jsx: true });
      if (lower.endsWith(".mjs")) return javascript();
      if (lower.endsWith(".cjs")) return javascript();
      if (lower.endsWith(".json")) return json();
      if (lower.endsWith(".html") || lower.endsWith(".htm")) return htmlLanguage();
      if (lower.endsWith(".css")) return css();
      if (lower.endsWith(".md") || lower.endsWith(".mdx")) return markdown();
      if (lower.endsWith(".py")) return python();
      if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return yaml();
      return null;
    }

    function buildExtensions() {
      const extensions = [
        lineNumbers(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        EditorView.theme(
          {
            "&": { height: "100%", backgroundColor: "#1D1D1D", color: "#E8E8E3" },
            ".cm-scroller": { padding: "16px 0 16px 0" },
            ".cm-content": { padding: "0 16px", caretColor: "#D9544F" },
            ".cm-lineNumbers .cm-gutterElement": { color: "rgba(232, 232, 227, 0.35)" },
            ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.05)" },
            ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
            ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(217, 84, 79, 0.25)" }
          },
          { dark: true }
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            debouncedSave();
          }
        })
      ];

      const languageExtension = resolveLanguageExtension(FILE_NAME);
      if (languageExtension) {
        extensions.push(languageExtension);
      }

      if (READONLY) {
        extensions.push(EditorView.editable.of(false));
      }

      return extensions;
    }

    function getContent() {
      if (!editorView) {
        return "";
      }
      return editorView.state.doc.toString();
    }

    function saveWithHttpFallback(content) {
      return fetch(saveUrl, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: content
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error("save-failed");
          }
          updateStatus("Saved", "saved");
        })
        .catch(() => {
          updateStatus("Save failed", "saving");
        });
    }

    function save() {
      if (READONLY) {
        return;
      }
      const content = getContent();
      updateStatus("Saving...", "saving");

      if (socketConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "save", content }));
        return;
      }

      void saveWithHttpFallback(content);
    }

    function debouncedSave() {
      if (READONLY) {
        return;
      }
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      updateStatus("Typing...", "saving");
      saveTimeout = setTimeout(save, SAVE_DEBOUNCE_MS);
    }

    function connectWebSocket() {
      if (READONLY || sharePrefix.length === 0) {
        return;
      }
      const socketUrl = new URL(window.location.href);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.pathname = sharePrefix;
      socketUrl.search = "";
      socketUrl.hash = "";

      ws = new WebSocket(socketUrl.toString());
      ws.onopen = () => {
        socketConnected = true;
        updateStatus("Ready", "saved");
      };
      ws.onclose = () => {
        socketConnected = false;
        updateStatus("Offline - HTTP save", "saving");
        setTimeout(connectWebSocket, 3000);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "saved") {
            updateStatus("Saved", "saved");
          } else if (data.type === "error") {
            updateStatus("Save failed", "saving");
          }
        } catch {
          return;
        }
      };
    }

    function initEditor(content) {
      editorView = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: buildExtensions()
        }),
        parent: document.getElementById("editor")
      });

      if (READONLY) {
        updateStatus("Read-only", "readonly");
      } else if (!socketConnected) {
        updateStatus("Ready", "saved");
      }
    }

    const sharePrefix = resolveSharePrefix();
    const contentUrl = sharePrefix + "/api/content";
    const saveUrl = sharePrefix + "/api/save";

    fetch(contentUrl, { cache: "no-store" })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("load-failed"))))
      .then((content) => {
        initEditor(content);
      })
      .catch(() => {
        updateStatus("Load failed", "saving");
        initEditor("");
      });


    document.addEventListener("visibilitychange", () => {
      if (READONLY || document.hidden === false || !saveTimeout) {
        return;
      }
      clearTimeout(saveTimeout);
      saveTimeout = null;
      save();
    });

    window.addEventListener("beforeunload", () => {
      if (READONLY || !saveTimeout) {
        return;
      }
      clearTimeout(saveTimeout);
      saveTimeout = null;
      save();
    });
  </script>
</body>
</html>
`;
}

export function generateMarkdownEditorHtml(filename: string, readonly: boolean): string {
  const escapedFilename = escapeHtml(filename);
  const filenameJson = JSON.stringify(filename);
  const readonlyJson = readonly ? "true" : "false";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapedFilename}</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#1D1D1D">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      background: #1D1D1D;
      color: #E8E8E3;
      font-family: "Avenir Next", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      -webkit-text-size-adjust: 100%;
    }
    #app {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    #editor-container {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 44px;
    }
    .ProseMirror {
      width: 100%;
      min-height: 100%;
      padding: 20px;
      background: #1D1D1D;
      color: #E8E8E3;
      border: none;
      outline: none;
      font-family: "Avenir Next", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      font-size: 17px;
      line-height: 1.65;
      caret-color: #D9544F;
    }
    .ProseMirror:focus { outline: none; }
    .ProseMirror p { margin: 0 0 0.8em 0; }
    .ProseMirror p:last-child { margin-bottom: 0; }
    .ProseMirror h1 {
      font-size: 28px;
      font-weight: 700;
      margin: 0 0 0.5em 0;
      color: #E8E8E3;
      line-height: 1.3;
    }
    .ProseMirror h2 {
      font-size: 22px;
      font-weight: 700;
      margin: 0.8em 0 0.4em 0;
      color: #E8E8E3;
      line-height: 1.3;
    }
    .ProseMirror h3 {
      font-size: 18px;
      font-weight: 700;
      margin: 0.6em 0 0.3em 0;
      color: #E8E8E3;
      line-height: 1.3;
    }
    .ProseMirror strong { font-weight: 600; color: #E8E8E3; }
    .ProseMirror em { font-style: italic; }
    .ProseMirror a { color: #D9544F; text-decoration: none; }
    .ProseMirror a:hover { text-decoration: underline; }
    .ProseMirror ul, .ProseMirror ol {
      margin: 0 0 0.8em 0;
      padding-left: 1.5em;
    }
    .ProseMirror li {
      margin: 0.3em 0;
      line-height: 1.5;
    }
    .ProseMirror ul li { list-style-type: disc; }
    .ProseMirror ol li { list-style-type: decimal; }
    .ProseMirror ul li::marker, .ProseMirror ol li::marker { color: #666; }
    .ProseMirror ul[data-type="taskList"] {
      list-style: none;
      padding-left: 0;
      margin: 0 0 0.8em 0;
    }
    .ProseMirror ul[data-type="taskList"] li {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin: 0.4em 0;
    }
    .ProseMirror ul[data-type="taskList"] li > label {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 3px;
    }
    .ProseMirror ul[data-type="taskList"] li > div {
      flex: 1;
      min-width: 0;
    }
    .ProseMirror ul[data-type="taskList"] input[type="checkbox"] {
      -webkit-appearance: none;
      appearance: none;
      width: 19px;
      height: 19px;
      margin: 0;
      border: 1.5px solid #555;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      position: relative;
      transition: background 0.15s ease, border-color 0.15s ease;
      flex-shrink: 0;
    }
    .ProseMirror ul[data-type="taskList"] input[type="checkbox"]:checked {
      background: #D9544F;
      border-color: #D9544F;
    }
    .ProseMirror ul[data-type="taskList"] input[type="checkbox"]:checked::after {
      content: "";
      position: absolute;
      left: 5px;
      top: 2px;
      width: 6px;
      height: 10px;
      border: solid #fff;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div {
      text-decoration: line-through;
      color: #777;
      transition: color 0.15s ease;
    }
    .ProseMirror blockquote {
      margin: 0.8em 0;
      padding: 0.5em 0 0.5em 1em;
      border-left: 4px solid #444;
      color: #999;
      font-style: italic;
    }
    .ProseMirror code {
      font-family: "SF Mono", Monaco, "Cascadia Code", "Fira Code", monospace;
      background: #2a2a2a;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .ProseMirror p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: left;
      color: #555;
      pointer-events: none;
      height: 0;
    }
    .ProseMirror ::selection { background: rgba(217, 84, 79, 0.25); }
    #status {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      min-height: 36px;
      background: rgba(24, 24, 24, 0.88);
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      border-top: 0.5px solid rgba(255, 255, 255, 0.06);
      color: rgba(232, 232, 227, 0.55);
      font-family: "Avenir Next", -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      font-size: 12px;
      z-index: 50;
    }
    #status-text { white-space: nowrap; }
    #status-filename {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 12px;
    }
    #status.saving #status-text { color: rgba(232, 168, 56, 0.8); }
    #status.saved #status-text { color: rgba(217, 84, 79, 0.7); }
    #status.readonly #status-text { color: rgba(232, 232, 227, 0.75); }
    @media (max-width: 600px) {
      .ProseMirror { font-size: 17px; padding: 16px; }
    }
  </style>
  <script type="importmap">
  {
    "imports": {
      "@tiptap/core": "https://esm.sh/@tiptap/core@2.11.0?bundle",
      "@tiptap/starter-kit": "https://esm.sh/@tiptap/starter-kit@2.11.0?bundle",
      "@tiptap/extension-task-list": "https://esm.sh/@tiptap/extension-task-list@2.11.0?bundle",
      "@tiptap/extension-task-item": "https://esm.sh/@tiptap/extension-task-item@2.11.0?bundle",
      "@tiptap/extension-placeholder": "https://esm.sh/@tiptap/extension-placeholder@2.11.0?bundle",
      "marked": "https://esm.sh/marked@15.0.6?bundle",
      "turndown": "https://esm.sh/turndown@7.2.0?bundle"
    }
  }
  </script>
</head>
<body>
  <div id="app">
    <div id="editor-container">
      <div id="editor"></div>
    </div>
    <div id="status">
      <span id="status-filename">${escapedFilename}</span>
      <span id="status-text">Loading...</span>
    </div>
  </div>

  <script type="module">
    import { Editor } from "@tiptap/core";
    import StarterKit from "@tiptap/starter-kit";
    import TaskList from "@tiptap/extension-task-list";
    import TaskItem from "@tiptap/extension-task-item";
    import Placeholder from "@tiptap/extension-placeholder";
    import { marked } from "marked";
    import TurndownService from "turndown";

    const FILE_NAME = ${filenameJson};
    const READONLY = ${readonlyJson};
    const SAVE_DEBOUNCE_MS = 1000;

    const turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced"
    });

    turndownService.addRule("taskList", {
      filter: (node) => {
        return node.nodeName === "UL" && node.getAttribute("data-type") === "taskList";
      },
      replacement: (content) => {
        const lines = content.trim().split("\\n");
        return "\\n" + lines.map((line) => {
          const match = line.match(/^\\s*([\\-*])\\s+(\\[[ x]\\])\\s*(.*)$/);
          if (!match) {
            return line;
          }
          const isChecked = match[2] === "[x]";
          return "- [" + (isChecked ? "x" : " ") + "] " + match[3];
        }).join("\\n") + "\\n";
      }
    });

    turndownService.addRule("taskItem", {
      filter: (node) => {
        return node.nodeName === "LI" && node.querySelector("input[type=\\"checkbox\\"]");
      },
      replacement: (content, node) => {
        const checkbox = node.querySelector("input[type=\\"checkbox\\"]");
        const isChecked = checkbox?.checked || false;
        const textContent = content.replace(/^\\s*[-*]\\s*/, "").trim();
        return "- [" + (isChecked ? "x" : " ") + "] " + textContent;
      }
    });

    let editor = null;
    let ws = null;
    let saveTimeout = null;
    let socketConnected = false;

    const statusEl = document.getElementById("status");
    const statusFilename = document.getElementById("status-filename");
    const statusText = document.getElementById("status-text");

    statusFilename.textContent = FILE_NAME;
    document.title = FILE_NAME;

    function updateStatus(text, cls) {
      statusText.textContent = text;
      statusEl.className = cls || "";
    }

    function resolveSharePrefix() {
      const match = window.location.pathname.match(/^\\/s\\/([A-Za-z0-9_-]+)/);
      if (!match) {
        return "";
      }
      return "/s/" + match[1];
    }

    const sharePrefix = resolveSharePrefix();

    function getMarkdown() {
      if (!editor) {
        return "";
      }
      return turndownService.turndown(editor.getHTML());
    }

    function saveWithHttpFallback(content) {
      return fetch(saveUrl, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: content
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error("save-failed");
          }
          updateStatus("Saved", "saved");
        })
        .catch(() => {
          updateStatus("Save failed", "saving");
        });
    }

    function save() {
      if (READONLY) {
        return;
      }
      updateStatus("Saving...", "saving");
      const content = getMarkdown();
      if (socketConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "save", content }));
        return;
      }

      void saveWithHttpFallback(content);
    }

    function debouncedSave() {
      if (READONLY) {
        return;
      }
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      updateStatus("Typing...", "saving");
      saveTimeout = setTimeout(save, SAVE_DEBOUNCE_MS);
    }

    function connectWebSocket() {
      if (READONLY || sharePrefix.length === 0) {
        return;
      }
      const socketUrl = new URL(window.location.href);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.pathname = sharePrefix;
      socketUrl.search = "";
      socketUrl.hash = "";

      ws = new WebSocket(socketUrl.toString());
      ws.onopen = () => {
        socketConnected = true;
        updateStatus("Ready", "saved");
      };
      ws.onclose = () => {
        socketConnected = false;
        updateStatus("Disconnected", "saving");
        setTimeout(connectWebSocket, 3000);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "saved") {
            updateStatus("Saved", "saved");
          } else if (data.type === "error") {
            updateStatus("Save failed", "saving");
          }
        } catch {
          return;
        }
      };
    }

    function initEditor(contentMarkdown) {
      marked.setOptions({
        gfm: true,
        breaks: true,
        headerIds: false,
        mangle: false
      });

      editor = new Editor({
        element: document.getElementById("editor"),
        editable: !READONLY,
        extensions: [
          StarterKit.configure({
            heading: { levels: [1, 2, 3] },
            bulletList: { keepMarks: true, keepAttributes: false },
            orderedList: { keepMarks: true, keepAttributes: false },
            listItem: { HTMLAttributes: { class: "list-item" } }
          }),
          TaskList.configure({
            HTMLAttributes: { class: "task-list" }
          }),
          TaskItem.configure({
            nested: true,
            HTMLAttributes: { class: "task-item" }
          }),
          Placeholder.configure({
            placeholder: "Start typing...",
            showOnlyWhenEditable: true
          })
        ],
        content: marked.parse(contentMarkdown),
        onUpdate: debouncedSave,
        editorProps: {
          attributes: {
            spellcheck: "false",
            autocapitalize: "sentences",
            autocomplete: "off",
            autocorrect: "on"
          }
        }
      });

      if (READONLY) {
        updateStatus("Read-only", "readonly");
      } else if (!socketConnected) {
        updateStatus("Ready", "saved");
      }
    }

    const contentUrl = sharePrefix + "/api/content";
    const saveUrl = sharePrefix + "/api/save";
    fetch(contentUrl, { cache: "no-store" })
      .then((response) => response.ok ? response.text() : Promise.reject(new Error("load-failed")))
      .then((content) => {
        initEditor(content);
      })
      .catch(() => {
        updateStatus("Load failed", "saving");
        initEditor("");
      });


    document.addEventListener("visibilitychange", () => {
      if (READONLY || document.hidden === false || !saveTimeout) {
        return;
      }
      clearTimeout(saveTimeout);
      saveTimeout = null;
      save();
    });

    window.addEventListener("beforeunload", () => {
      if (READONLY || !saveTimeout) {
        return;
      }
      clearTimeout(saveTimeout);
      saveTimeout = null;
      save();
    });
  </script>
</body>
</html>
`;
}
