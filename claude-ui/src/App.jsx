// claude-ui/src/App.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

export default function App() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [aliases, setAliases] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [focused, setFocused] = useState(false);

  // サイドバー
  const [activeSideTab, setActiveSideTab] = useState("files"); // 'files' | 'aliases'

  // @補完
  const [suggestions, setSuggestions] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestPos, setSuggestPos] = useState({ left: 0, top: 0, placement: "bottom" });
  const [showSuggest, setShowSuggest] = useState(false);

  // ファイルツリー
  const [roots, setRoots] = useState([]);
  const [childrenMap, setChildrenMap] = useState(new Map());
  const [expanded, setExpanded] = useState(new Set());

  // クイック検索
  const [q, setQ] = useState("");
  const [qBusy, setQBusy] = useState(false);
  const [qResults, setQResults] = useState([]);

  // 右クリックメニュー
  const [ctx, setCtx] = useState({ show: false, x: 0, y: 0, node: null });

  // プレビュー
  const [preview, setPreview] = useState({ open: false, info: null, loading: false, error: null });

  const textRef = useRef(null);
  const bottomRef = useRef(null);
  const qTimer = useRef(null);

  // 初回：プロジェクト一覧
  useEffect(() => {
    fetch(`${API_BASE}/projects`)
      .then((r) => r.json())
      .then((data) => {
        setProjects(data);
        if (data.length) {
          setProjectId(data[0].id);
          setAliases(data[0].aliases || {});
        }
      })
      .catch(() => {});
  }, []);

  // プロジェクト切替：aliases / roots
  useEffect(() => {
    if (!projectId) return;
    fetch(`${API_BASE}/projects/${projectId}`)
      .then((r) => r.json())
      .then((data) => setAliases(data.aliases || {}))
      .catch(() => {});
    fetch(`${API_BASE}/projects/${projectId}/fs`)
      .then((r) => r.json())
      .then((data) => {
        setRoots(data.items || []);
        setChildrenMap(new Map());
        setExpanded(new Set());
      })
      .catch(() => {});
    // 検索をクリア
    setQ(""); setQResults([]);
  }, [projectId]);

  // 自動スクロール
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // 候補ポップの追従
  useEffect(() => {
    const handler = () => recalcSuggestPosition();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [showSuggest]);

  // 右クリックメニューの外側クリックで閉じる
  useEffect(() => {
    const close = () => setCtx((c) => ({ ...c, show: false }));
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, []);

  const aliasKeys = useMemo(() => Object.keys(aliases || {}), [aliases]);
  const aliasByPath = useMemo(() => {
    const inv = new Map();
    Object.entries(aliases || {}).forEach(([k, v]) => inv.set(v, k));
    return inv;
  }, [aliases]);

  // 入力欄
  const onInputChange = (e) => {
    setInput(e.target.value);
    autoResize(e.currentTarget);
    updateSuggestions(e.currentTarget);
  };
  const onTextareaClick = () => updateSuggestions(textRef.current);

  // @補完制御
  const updateSuggestions = (el) => {
    if (!el) return;
    if (isComposing) { setSuggestions([]); setShowSuggest(false); return; }
    const caret = el.selectionStart ?? 0;
    const prefix = getAtPrefix(el.value, caret);
    if (!prefix) { setSuggestions([]); setShowSuggest(false); setActiveIndex(-1); return; }
    const cand = aliasKeys.filter((k) => k.startsWith(prefix)).slice(0, 8);
    setSuggestions(cand);
    setActiveIndex(cand.length ? 0 : -1);
    setShowSuggest(!!cand.length);
    recalcSuggestPosition();
  };
  const recalcSuggestPosition = () => {
    const el = textRef.current;
    if (!el || !showSuggest) return;
    const caretRect = getCaretClientRect(el);
    if (!caretRect) return;
    const needFlip = window.innerHeight - caretRect.bottom < 220;
    setSuggestPos({
      left: Math.round(caretRect.left),
      top: Math.round(needFlip ? caretRect.top : caretRect.bottom),
      placement: needFlip ? "top" : "bottom",
    });
  };
  const pickSuggestion = (alias) => insertAtCaret(alias);

  // ファイルツリー
  const toggleDir = async (rel) => {
    const next = new Set(expanded);
    if (next.has(rel)) { next.delete(rel); setExpanded(next); return; }
    if (!childrenMap.has(rel)) {
      try {
        const res = await fetch(`${API_BASE}/projects/${projectId}/fs?path=${encodeURIComponent(rel)}`);
        const data = await res.json();
        const map = new Map(childrenMap); map.set(rel, data.items || []); setChildrenMap(map);
      } catch {}
    }
    next.add(rel); setExpanded(next);
  };

  const insertMentionForPath = (rel) => {
    const alias = aliasByPath.get(rel);
    insertAtCaret(alias ? alias : "@" + rel);
    textRef.current?.focus();
  };

  // クイック検索（デバウンス）
  const onQChange = (e) => {
    const nv = e.target.value;
    setQ(nv);
    if (qTimer.current) clearTimeout(qTimer.current);
    if (!nv.trim()) { setQResults([]); setQBusy(false); return; }
    setQBusy(true);
    qTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/projects/${projectId}/search?q=${encodeURIComponent(nv.trim())}`);
        const data = await r.json();
        setQResults(data.items || []);
      } catch { setQResults([]); }
      setQBusy(false);
    }, 250);
  };

  // プレビュー
  const openPreview = async (rel) => {
    setPreview({ open: true, info: null, loading: true, error: null });
    try {
      const r = await fetch(`${API_BASE}/projects/${projectId}/file?path=${encodeURIComponent(rel)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setPreview({ open: true, info: data, loading: false, error: null });
    } catch (e) {
      setPreview({ open: true, info: null, loading: false, error: String(e.message || e) });
    }
  };
  const closePreview = () => setPreview({ open: false, info: null, loading: false, error: null });

  // 送信
  const sendPrompt = async () => {
    const prompt = input.trim();
    if (!prompt || !projectId || loading) return;
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text: prompt, projectId }]);
    setInput(""); resetTextareaHeight(textRef.current); setShowSuggest(false);

    try {
      const res = await fetch(`${API_BASE}/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, project_id: projectId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", text: data?.text ?? "(no text)", meta: data?.meta ?? null }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  // キー操作
  const onKeyDown = (e) => {
    const native = e.nativeEvent;
    const composingNow = isComposing || native?.isComposing || native?.keyCode === 229;

    if (showSuggest && suggestions.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => (i + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Tab")       { e.preventDefault(); if (activeIndex >= 0) pickSuggestion(suggestions[activeIndex]); return; }
      if (e.key === "Enter" && !composingNow) { e.preventDefault(); if (activeIndex >= 0) { pickSuggestion(suggestions[activeIndex]); return; } }
      if (e.key === "Escape")    { e.preventDefault(); setShowSuggest(false); return; }
    }

    if (e.key === "Enter") {
      if (composingNow) return;
      if (e.shiftKey) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendPrompt(); return; }
      e.preventDefault(); sendPrompt();
    }
  };

  const clearAll = () => { setMessages([]); setInput(""); resetTextareaHeight(textRef.current); setShowSuggest(false); };

  // 文字列挿入（キャレット）
  const insertAtCaret = (token) => {
    const el = textRef.current; if (!el) return;
    const start = el.selectionStart ?? input.length; const end = el.selectionEnd ?? input.length;
    const before = input.slice(0, start); const after = input.slice(end);
    const sepBefore = before && !/\s$/.test(before) ? " " : "";
    const sepAfter  = after  && !/^\s/.test(after)  ? " " : "";
    const next = `${before}${sepBefore}${token}${sepAfter}${after}`;
    setInput(next);
    requestAnimationFrame(() => { el.focus(); const pos = (before + sepBefore + token).length; el.selectionStart = el.selectionEnd = pos; autoResize(el); });
  };

  // 右クリックメニュー
  const onContextMenuNode = (e, node) => {
    e.preventDefault();
    setCtx({ show: true, x: e.clientX, y: e.clientY, node });
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); } catch {} };
  const copyMentionForPath = (rel) => {
    const alias = aliasByPath.get(rel);
    copy(alias ? alias : "@" + rel);
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Claude Code (Shared Projects)</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, opacity: 0.8 }}>Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={styles.select}>
            {projects.map((p) => (<option key={p.id} value={p.id}>{p.name || p.id}</option>))}
          </select>
        </div>
      </header>

      <main style={styles.main}>
        {/* メッセージ */}
        <div style={styles.messages} onClick={onTextareaClick}>
          {messages.map((m, i) => (
            <div key={i} style={{ ...styles.bubble, ...(m.role === "user" ? styles.user : styles.assistant) }}>
              <div style={styles.metaRow}><span style={styles.role}>{m.role}</span>{m.projectId && <span style={styles.tag}>#{m.projectId}</span>}</div>
              <div style={styles.text}>
                {m.role === "assistant"
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                      code: CodeRenderer, a: (p) => <a {...p} target="_blank" rel="noreferrer" />,
                      table: (p) => <table style={styles.mdTable} {...p} />, th: (p) => <th style={styles.mdTh} {...p} />,
                      td: (p) => <td style={styles.mdTd} {...p} />, blockquote: (p) => <blockquote style={styles.mdQuote} {...p} />,
                      ul: (p) => <ul style={styles.mdUl} {...p} />, ol: (p) => <ol style={styles.mdOl} {...p} />, li: (p) => <li style={styles.mdLi} {...p} />,
                    }}>{m.text}</ReactMarkdown>
                  : <pre style={styles.userPre}>{m.text}</pre>}
              </div>
              {m.meta && (<details style={styles.details}><summary>meta</summary><pre style={styles.pre}>{JSON.stringify(m.meta, null, 2)}</pre></details>)}
            </div>
          ))}
          {loading && (<div style={{ ...styles.bubble, ...styles.assistant }}><div style={styles.role}>assistant</div><div>Thinking…</div></div>)}
          <div ref={bottomRef} />
        </div>

        {/* サイドバー */}
        <aside style={styles.sidebar}>
          <div style={styles.tabs}>
            <button style={{ ...styles.tabBtn, ...(activeSideTab === "files" ? styles.tabActive : null) }} onClick={() => setActiveSideTab("files")}>Files</button>
            <button style={{ ...styles.tabBtn, ...(activeSideTab === "aliases" ? styles.tabActive : null) }} onClick={() => setActiveSideTab("aliases")}>Aliases</button>
          </div>

          {activeSideTab === "files" && (
            <>
              <input
                value={q}
                onChange={onQChange}
                placeholder="Quick filter (name contains...)"
                style={styles.search}
              />
              {q ? (
                <div style={styles.searchResultHead}>
                  <span>{qBusy ? "Searching…" : `${qResults.length} results`}</span>
                  {q && <button style={styles.clearSmall} onClick={() => { setQ(""); setQResults([]); }}>Clear</button>}
                </div>
              ) : null}

              {q ? (
                <div style={styles.tree}>
                  {qResults.map((n) => (
                    <SearchRow key={n.rel} node={n}
                      onInsert={() => insertMentionForPath(n.rel)}
                      onPreview={() => openPreview(n.rel)}
                      onContextMenu={(e) => onContextMenuNode(e, n)}
                    />
                  ))}
                  {!qBusy && !qResults.length && <div style={{ opacity: 0.6, fontSize: 12 }}>No matches</div>}
                </div>
              ) : (
                <div style={styles.tree}>
                  {roots.map((node) => (
                    <TreeNode key={node.rel} node={node}
                      expanded={expanded} childrenMap={childrenMap}
                      onToggle={toggleDir}
                      onInsert={insertMentionForPath}
                      onPreview={openPreview}
                      onContextMenu={onContextMenuNode}
                    />
                  ))}
                  {!roots.length && <div style={{ opacity: 0.6, fontSize: 12 }}>No roots</div>}
                </div>
              )}
            </>
          )}

          {activeSideTab === "aliases" && (
            <>
              <h3 style={{ marginTop: 12 }}>Aliases</h3>
              <ul style={styles.ul}>
                {aliasKeys.map((k) => (
                  <li key={k}>
                    <button style={styles.linkBtn} onClick={() => insertAtCaret(k)}>{k}</button>
                    <span style={styles.aliasPath}>→ {aliases[k]}</span>
                  </li>
                ))}
                {!aliasKeys.length && <li style={{ opacity: 0.6 }}>No aliases</li>}
              </ul>
            </>
          )}

          <div style={{ marginTop: 12, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
            Enter: 送信 / Shift+Enter: 改行 / ⌘(Ctrl)+Enter: 送信 / <b>変換中は送信しません</b>
          </div>
        </aside>

        {/* 入力ボックス（ChatGPT風） */}
        <div style={styles.composer}>
          <div style={{ ...styles.inputWrap, ...(focused ? styles.inputWrapFocused : null) }} onClick={() => textRef.current?.focus()}>
            <textarea
              ref={textRef}
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={(e) => { setIsComposing(false); setInput(e.currentTarget.value); autoResize(e.currentTarget); updateSuggestions(e.currentTarget); }}
              placeholder="例）@routes を修正。関数 foo を bar にリネームして、pytest 計画を教えて。"
              style={styles.textarea}
              rows={1}
            />
            <button onClick={sendPrompt} disabled={loading || !input.trim() || !projectId} aria-label="Send"
              style={{ ...styles.sendIconBtn, ...(loading || !input.trim() || !projectId ? styles.sendIconBtnDisabled : null) }}>
              <SendIcon />
            </button>
          </div>
          <button onClick={clearAll} style={styles.secondary}>Clear</button>
        </div>
      </main>

      {/* @候補ポップ */}
      {showSuggest && suggestions.length > 0 && (
        <div style={{ ...styles.suggestFloating, left: suggestPos.left, top: suggestPos.top + (suggestPos.placement === "bottom" ? 8 : -8), transform: suggestPos.placement === "top" ? "translateY(-100%)" : "none" }}>
          {suggestions.map((s, i) => (
            <div key={s} style={{ ...styles.suggestItem, ...(i === activeIndex ? styles.suggestActive : null) }}
              onMouseDown={() => insertAtCaret(s)} onMouseEnter={() => setActiveIndex(i)}>
              {s} <span style={styles.aliasPath}>→ {aliases[s]}</span>
            </div>
          ))}
        </div>
      )}

      {/* 右クリックメニュー */}
      {ctx.show && ctx.node && (
        <div style={{ ...styles.ctxMenu, left: ctx.x, top: ctx.y }}>
          <div style={styles.ctxItem} onMouseDown={() => insertMentionForPath(ctx.node.rel)}>Insert @mention</div>
          <div style={styles.ctxItem} onMouseDown={() => copyMentionForPath(ctx.node.rel)}>Copy @mention</div>
          <div style={styles.ctxItem} onMouseDown={() => copy(ctx.node.rel)}>Copy path</div>
          {ctx.node.type === "file" && <div style={styles.ctxItem} onMouseDown={() => openPreview(ctx.node.rel)}>Preview</div>}
        </div>
      )}

      {/* プレビューモーダル */}
      {preview.open && (
        <div style={styles.modalBackdrop} onClick={closePreview}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <div style={{ fontWeight: 600 }}>{preview.info?.rel || "Preview"}</div>
              <button style={styles.modalClose} onClick={closePreview}>✕</button>
            </div>
            <div style={styles.modalBody}>
              {preview.loading && <div>Loading…</div>}
              {preview.error && <div style={{ color: "crimson" }}>{preview.error}</div>}
              {(!preview.loading && preview.info) && (
                <>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
                    {preview.info.mime} • {formatBytes(preview.info.size)}{preview.info.truncated ? " • truncated" : ""}
                  </div>
                  {preview.info.is_text ? (
                    <pre style={styles.codeBlock}><code>{preview.info.content}</code></pre>
                  ) : (
                    <div>Binary or unsupported text. Open in editor on your machine.</div>
                  )}
                </>
              )}
            </div>
            <div style={styles.modalFoot}>
              <button style={styles.secondary} onClick={() => insertMentionForPath(preview.info?.rel || "")}>Insert @mention</button>
              <button style={styles.secondary} onClick={() => copyMentionForPath(preview.info?.rel || "")}>Copy @mention</button>
              <button style={styles.secondary} onClick={() => copy(preview.info?.rel || "")}>Copy path</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- サブ: ツリーと検索行 ---
function TreeNode({ node, expanded, childrenMap, onToggle, onInsert, onPreview, onContextMenu }) {
  const isDir = node.type === "dir"; const isOpen = expanded.has(node.rel); const children = childrenMap.get(node.rel) || [];
  return (
    <div onContextMenu={(e) => onContextMenu(e, node)}>
      <div style={styles.treeRow}>
        {isDir ? (<button style={styles.treeToggle} onClick={() => onToggle(node.rel)} aria-label="toggle">{isOpen ? "▾" : "▸"}</button>)
               : (<span style={{ width: 18, display: "inline-block" }} />)}
        <span style={isDir ? styles.treeDir : styles.treeFile}
              onClick={() => (isDir ? onToggle(node.rel) : onInsert(node.rel))}>
          {isDir ? "📁 " : "📄 "}{node.name}
        </span>
        {!isDir && (<div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button style={styles.miniBtn} onClick={() => onInsert(node.rel)}>@</button>
          <button style={styles.miniBtn} onClick={() => onPreview(node.rel)}>👁</button>
        </div>)}
      </div>
      {isDir && isOpen && (
        <div style={{ marginLeft: 18 }}>
          {children.map((ch) => (
            <TreeNode key={ch.rel} node={ch} expanded={expanded} childrenMap={childrenMap}
              onToggle={onToggle} onInsert={onInsert} onPreview={onPreview} onContextMenu={onContextMenu} />
          ))}
          {!children.length && <div style={styles.treeEmpty}>empty</div>}
        </div>
      )}
    </div>
  );
}
function SearchRow({ node, onInsert, onPreview, onContextMenu }) {
  return (
    <div style={styles.searchRow} onContextMenu={(e) => onContextMenu(e, node)}>
      <span>{node.type === "dir" ? "📁" : "📄"}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.rel}</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        <button style={styles.miniBtn} onClick={onInsert}>@</button>
        {node.type === "file" && <button style={styles.miniBtn} onClick={onPreview}>👁</button>}
      </div>
    </div>
  );
}

// --- Markdown code ---
function CodeRenderer({ inline, children, ...props }) {
  if (inline) return <code style={styles.codeInline} {...props}>{children}</code>;
  return <pre style={styles.codeBlock}><code {...props}>{children}</code></pre>;
}

// --- caret utils ---
function getAtPrefix(value, caret) { const left = value.slice(0, caret); const m = left.match(/@[\w\-\._/]*$/); return m ? m[0] : null; }
function getAtPrefixRange(value, caret) { const left = value.slice(0, caret); const m = left.match(/@[\w\-\._/]*$/); if (!m) return { start: caret, end: caret }; return { start: caret - m[0].length, end: caret }; }
function getCaretClientRect(el) {
  const taRect = el.getBoundingClientRect(); const cs = window.getComputedStyle(el); const div = document.createElement("div");
  div.style.position = "fixed"; div.style.left = taRect.left + "px"; div.style.top = taRect.top + "px"; div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap"; div.style.wordWrap = "break-word"; div.style.overflow = "hidden"; div.style.boxSizing = cs.boxSizing;
  div.style.width = taRect.width + "px"; div.style.padding = cs.padding; div.style.border = cs.border; div.style.font = cs.font;
  div.style.lineHeight = cs.lineHeight; div.style.letterSpacing = cs.letterSpacing;
  const caretIndex = el.selectionStart || 0; const before = el.value.slice(0, caretIndex);
  const frag = document.createDocumentFragment(); const lines = before.split("\n");
  lines.forEach((ln, idx) => { frag.appendChild(document.createTextNode(ln)); if (idx !== lines.length - 1) frag.appendChild(document.createElement("br")); });
  const span = document.createElement("span"); span.textContent = "\u200b"; frag.appendChild(span);
  div.appendChild(frag); document.body.appendChild(div); const rect = span.getBoundingClientRect(); document.body.removeChild(div);
  return rect?.width || rect?.height ? rect : { left: taRect.left, top: taRect.bottom, bottom: taRect.bottom, right: taRect.right, height: 0, width: 0 };
}

// --- textarea auto-resize ---
function autoResize(el) { if (!el) return; el.style.height = "auto"; const max = 320; el.style.height = Math.min(max, el.scrollHeight) + "px"; }
function resetTextareaHeight(el) { if (!el) return; el.style.height = "auto"; }

// --- helpers ---
function SendIcon() { return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 11.5l17-8-7.5 17-2-6-6-3z" stroke="currentColor" strokeWidth="1.8" fill="none" /></svg>); }
function formatBytes(n) { if (n < 1024) return `${n} B`; const kb = n / 1024; if (kb < 1024) return `${kb.toFixed(1)} KB`; const mb = kb / 1024; return `${mb.toFixed(1)} MB`; }

// --- styles ---
const styles = {
  container: { height: "100vh", display: "grid", gridTemplateRows: "48px 1fr", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "0 12px", borderBottom: "1px solid #eee", background: "#111827", color: "#e5e7eb" },
  main: { display: "grid", gridTemplateColumns: "1fr 320px", gridTemplateRows: "1fr auto", gap: 12, padding: 12 },
  messages: { gridColumn: "1 / 2", padding: 8, overflow: "auto" },

  sidebar: { gridColumn: "2 / 3", padding: 12, border: "1px solid #eee", borderRadius: 8, background: "#fafafa", height: "100%", overflow: "auto" },
  tabs: { display: "flex", gap: 6, marginBottom: 8 },
  tabBtn: { flex: 1, padding: "6px 8px", fontSize: 13, borderRadius: 8, border: "1px solid #ddd", background: "#fff", cursor: "pointer" },
  tabActive: { background: "#111827", color: "#fff", borderColor: "#111827" },

  search: { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", marginBottom: 8 },
  searchResultHead: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.8, marginBottom: 6 },
  clearSmall: { border: "1px solid #ddd", background: "#fff", borderRadius: 6, padding: "2px 6px", cursor: "pointer", fontSize: 12 },

  tree: { fontSize: 13, lineHeight: 1.6 },
  treeRow: { display: "flex", alignItems: "center", gap: 6, padding: "2px 0" },
  treeToggle: { width: 18, height: 18, border: "none", background: "transparent", cursor: "pointer", lineHeight: 1 },
  treeDir: { cursor: "pointer", userSelect: "none" },
  treeFile: { cursor: "pointer", userSelect: "none" },
  treeEmpty: { marginLeft: 18, opacity: 0.6, fontSize: 12 },
  miniBtn: { border: "1px solid #ddd", background: "#fff", borderRadius: 6, padding: "0 6px", cursor: "pointer", fontSize: 12 },

  ul: { margin: 0, paddingLeft: 16 },
  linkBtn: { border: "none", background: "transparent", color: "#111827", textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 13 },

  bubble: { padding: 12, borderRadius: 12, marginBottom: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.06)", border: "1px solid #eee", background: "#fff" },
  user: { borderColor: "#c7d2fe", background: "#eef2ff" },
  assistant: { borderColor: "#d1fae5", background: "#ecfdf5" },
  role: { fontSize: 12, opacity: 0.7, marginRight: 8 },
  tag: { fontSize: 12, background: "#e5e7eb", borderRadius: 6, padding: "1px 6px" },

  text: { whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 },
  userPre: { margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 },

  details: { marginTop: 8 },
  pre: { margin: 0, fontSize: 12, overflowX: "auto" },

  composer: { gridColumn: "1 / 3", display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" },
  inputWrap: { position: "relative", display: "flex", alignItems: "center", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "10px 48px 10px 12px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" },
  inputWrapFocused: { borderColor: "#111827", boxShadow: "0 0 0 3px rgba(17,24,39,0.12)" },
  textarea: { width: "100%", resize: "none", border: "none", outline: "none", background: "transparent", fontFamily: "inherit", lineHeight: 1.5, fontSize: 14, minHeight: 40, paddingRight: 6 },
  sendIconBtn: { position: "absolute", right: 8, bottom: 8, width: 36, height: 36, borderRadius: 9999, border: "1px solid #111827", background: "#111827", color: "#fff", display: "grid", placeItems: "center", cursor: "pointer" },
  sendIconBtnDisabled: { opacity: 0.45, cursor: "not-allowed" },
  secondary: { padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", color: "#333", cursor: "pointer", height: 40 },
  select: { height: 28, borderRadius: 6, padding: "0 8px" },

  suggestFloating: { position: "fixed", zIndex: 1000, minWidth: 220, maxWidth: 420, maxHeight: 240, overflowY: "auto", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.12)" },
  suggestItem: { padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid #f4f4f5", display: "flex", alignItems: "center", gap: 6 },
  suggestActive: { background: "#eef2ff" },

  // Markdown
  codeInline: { background: "#f3f4f6", borderRadius: 6, padding: "0 6px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  codeBlock: { margin: 0, padding: 12, background: "#0f172a", color: "#e5e7eb", borderRadius: 10, overflowX: "auto", fontSize: 13 },
  mdTable: { borderCollapse: "collapse", width: "100%", margin: "8px 0" },
  mdTh: { border: "1px solid #e5e7eb", background: "#f9fafb", padding: "6px 8px", textAlign: "left" },
  mdTd: { border: "1px solid #e5e7eb", padding: "6px 8px" },
  mdQuote: { borderLeft: "4px solid #e5e7eb", margin: "8px 0", padding: "4px 8px", color: "#374151", background: "#fafafa" },
  mdUl: { paddingLeft: 22, margin: "6px 0" },
  mdOl: { paddingLeft: 22, margin: "6px 0" },
  mdLi: { margin: "2px 0" },

  // Context menu
  ctxMenu: { position: "fixed", zIndex: 2000, background: "#fff", border: "1px solid #e5e7eb", boxShadow: "0 8px 24px rgba(0,0,0,.12)", borderRadius: 8, overflow: "hidden" },
  ctxItem: { padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #f4f4f5" },

  // Modal
  modalBackdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "grid", placeItems: "center", zIndex: 1500 },
  modal: { width: "min(920px, 92vw)", height: "min(70vh, 760px)", background: "#fff", borderRadius: 12, display: "grid", gridTemplateRows: "auto 1fr auto", overflow: "hidden" },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #eee" },
  modalBody: { padding: 12, overflow: "auto" },
  modalFoot: { padding: 10, borderTop: "1px solid #eee", display: "flex", gap: 8, justifyContent: "flex-end" },
  modalClose: { border: "1px solid #ddd", background: "#fff", borderRadius: 6, padding: "2px 8px", cursor: "pointer" },

  // 検索行
  searchRow: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" },
  aliasPath: { opacity: 0.7, fontSize: 12, marginLeft: 8 },
};
