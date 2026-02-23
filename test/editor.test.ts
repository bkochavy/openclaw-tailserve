import { describe, expect, it } from "vitest";

import { generateCodeEditorHtml, generateMarkdownEditorHtml, getEditorMode } from "../src/editor.js";

describe("getEditorMode", () => {
  it("returns markdown mode for markdown extensions", () => {
    expect(getEditorMode("notes.md")).toBe("markdown-editor");
    expect(getEditorMode("README.MDX")).toBe("markdown-editor");
    expect(getEditorMode("  changelog.Md  ")).toBe("markdown-editor");
  });

  it("returns code mode for all other supported extensions", () => {
    const codeEditorFiles = [
      "app.js",
      "app.jsx",
      "app.mjs",
      "app.ts",
      "app.tsx",
      "config.json",
      "doc.html",
      "doc.htm",
      "styles.css",
      "script.py",
      "config.yaml",
      "config.yml",
      "script.sh",
      "script.bash",
      "script.zsh",
      "Dockerfile"
    ];

    for (const filename of codeEditorFiles) {
      expect(getEditorMode(filename)).toBe("code-editor");
    }
  });
});

describe("generateCodeEditorHtml", () => {
  it("uses CodeMirror 6 importmap packages from esm.sh", () => {
    const html = generateCodeEditorHtml("app.ts", false);

    expect(html).toContain("@codemirror/state");
    expect(html).toContain("@codemirror/view");
    expect(html).toContain("@codemirror/commands");
    expect(html).toContain("@codemirror/language");
    expect(html).toContain("@codemirror/lang-javascript");
    expect(html).toContain("@codemirror/lang-json");
    expect(html).toContain("@codemirror/lang-html");
    expect(html).toContain("@codemirror/lang-css");
    expect(html).toContain("@codemirror/lang-markdown");
    expect(html).toContain("@codemirror/lang-python");
    expect(html).toContain("@codemirror/lang-yaml");
    expect(html).toContain("@codemirror/theme-one-dark");
  });

  it("keeps the dark shell and status bar styling", () => {
    const html = generateCodeEditorHtml("app.ts", false);

    expect(html).toContain("background: #1D1D1D;");
    expect(html).toContain("color: #E8E8E3;");
    expect(html).toContain("font-family: \"Avenir Next\"");
    expect(html).toContain("<div id=\"status\">");
    expect(html).toContain("<span id=\"status-text\">Loading...</span>");
  });

  it("escapes filename in title and status bar", () => {
    const html = generateCodeEditorHtml("<draft>.ts", false);

    expect(html).toContain("<title>&lt;draft&gt;.ts</title>");
    expect(html).toContain("<span id=\"status-filename\">&lt;draft&gt;.ts</span>");
  });

  it("sets up websocket save with HTTP POST fallback and debounce", () => {
    const html = generateCodeEditorHtml("app.ts", false);

    expect(html).toContain("const SAVE_DEBOUNCE_MS = 1000;");
    expect(html).toContain("ws.send(JSON.stringify({ type: \"save\", content }));");
    expect(html).toContain("method: \"POST\"");
    expect(html).toContain("setTimeout(save, SAVE_DEBOUNCE_MS)");
    expect(html).toContain("const saveUrl = sharePrefix + \"/api/save\";");
    expect(html).toContain("fetch(saveUrl, {");
  });

  it("supports readonly mode via CodeMirror readonly config", () => {
    const readonlyHtml = generateCodeEditorHtml("app.ts", true);
    const editableHtml = generateCodeEditorHtml("app.ts", false);

    expect(readonlyHtml).toContain("const READONLY = true;");
    expect(editableHtml).toContain("const READONLY = false;");
    expect(readonlyHtml).toContain("EditorView.editable.of(false)");
    expect(readonlyHtml).toContain("if (READONLY || sharePrefix.length === 0) {");
    expect(readonlyHtml).toContain("if (READONLY) {");
    expect(readonlyHtml).toContain("updateStatus(\"Read-only\", \"readonly\");");
  });
});

describe("generateMarkdownEditorHtml", () => {
  it("uses the md-editor import stack and dark prose styles", () => {
    const html = generateMarkdownEditorHtml("notes.md", false);

    expect(html).toContain("@tiptap/core@2.11.0?bundle");
    expect(html).toContain("@tiptap/starter-kit@2.11.0?bundle");
    expect(html).toContain("@tiptap/extension-task-list@2.11.0?bundle");
    expect(html).toContain("@tiptap/extension-task-item@2.11.0?bundle");
    expect(html).toContain("@tiptap/extension-placeholder@2.11.0?bundle");
    expect(html).toContain("marked@15.0.6?bundle");
    expect(html).toContain("turndown@7.2.0?bundle");
    expect(html).toContain("background: #1D1D1D;");
    expect(html).toContain("color: #E8E8E3;");
    expect(html).toContain("font-family: \"Avenir Next\"");
    expect(html).toContain(".ProseMirror");
    expect(html).toContain("ul[data-type=\"taskList\"]");
  });

  it("shows the filename in title and status bar", () => {
    const html = generateMarkdownEditorHtml("<draft>.md", false);

    expect(html).toContain("<title>&lt;draft&gt;.md</title>");
    expect(html).toContain("<span id=\"status-filename\">&lt;draft&gt;.md</span>");
    expect(html).not.toContain("<title>Ava Notes</title>");
  });

  it("builds content and websocket URLs from the current page URL", () => {
    const html = generateMarkdownEditorHtml("notes.md", false);

    expect(html).toContain("window.location.pathname.match(/^\\/s\\/([A-Za-z0-9_-]+)/)");
    expect(html).toContain("const contentUrl = sharePrefix + \"/api/content\";");
    expect(html).toContain("const socketUrl = new URL(window.location.href);");
    expect(html).toContain("socketUrl.protocol = socketUrl.protocol === \"https:\" ? \"wss:\" : \"ws:\";");
    expect(html).toContain("socketUrl.pathname = sharePrefix;");
  });

  it("autosaves over websocket with markdown conversion and 1s debounce", () => {
    const html = generateMarkdownEditorHtml("notes.md", false);

    expect(html).toContain("const saveUrl = sharePrefix + \"/api/save\";");
    expect(html).toContain("const SAVE_DEBOUNCE_MS = 1000;");
    expect(html).toContain("fetch(saveUrl, {");
    expect(html).toContain("return turndownService.turndown(editor.getHTML());");
    expect(html).toContain("setTimeout(save, SAVE_DEBOUNCE_MS)");
    expect(html).toContain("ws.send(JSON.stringify({ type: \"save\", content }));");
  });

  it("supports readonly mode via Tiptap editable config", () => {
    const readonlyHtml = generateMarkdownEditorHtml("notes.md", true);
    const editableHtml = generateMarkdownEditorHtml("notes.md", false);

    expect(readonlyHtml).toContain("const READONLY = true;");
    expect(editableHtml).toContain("const READONLY = false;");
    expect(readonlyHtml).toContain("editable: !READONLY,");
    expect(readonlyHtml).toContain("if (READONLY || sharePrefix.length === 0) {");
    expect(readonlyHtml).toContain("if (READONLY) {");
    expect(readonlyHtml).toContain("updateStatus(\"Read-only\", \"readonly\");");
  });
});
