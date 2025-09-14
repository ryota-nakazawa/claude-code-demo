// claude-ui/src/App.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

export default function App() {
  // プロジェクト & エイリアス
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [aliases, setAliases] = useState({});

  // メッセージ
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // 入力UI
  const [isComposing, setIsComposing] = useState(false);
  const [focused, setFocused] = useState(false);

  // サイドバー（Files / Aliases / Staged）
  const [activeSideTab, setActiveSideTab] = useState("files");

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

  // Staged（承認フロー）
  const [staged, setStaged] = useState([]);
  const [stagedBusy, setStagedBusy] = useState(false);
  const [selectedStaged, setSelectedStaged] = useState(null);
  const [stagedDiff, setStagedDiff] = useState("");
  const [stagedErr, setStagedErr] = useState("");
  const [stagedPending, setStagedPending] = useState({}); // { [rel]: 'approve'|'reject' }
  const [flash, setFlash] = useState({});                 // { [rel]: 'approved'|'rejected' }

  // Toasts
  const [toasts, setToasts] = useState([]);               // [{id,type,title,msg}]
  const toastIdRef = useRef(0);

  const textRef = useRef(null);
  const bottomRef = useRef(null);
  const qTimer = useRef(null);
  const esRef = useRef(null); // EventSource

  // ----------- 初期化：Keyframes（spinner用） -----------
  useEffect(() => {
    const id = "global-keyframes-injected";
    if (!document.getElementById(id)) {
      const style = document.createElement("style");
      style.id = id;
      style.innerHTML = `@keyframes spin { to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }
  }, []);

  // ----------- Toastユーティリティ -----------
  function pushToast({ type = "info", title = "", msg = "" }) {
    const id = ++toastIdRef.current;
    setToasts((t) => [...t, { id, type, title, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }

  // ----------- 初回：プロジェクト一覧 -----------
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

  // ----------- プロジェクト切替 -----------
  useEffect(() => {
    if (!projectId) return;
    // aliases
    fetch(`${API_BASE}/projects/${projectId}`)
      .then((r) => r.json())
      .then((data) => setAliases(data.aliases || {}))
      .catch(() => {});
    // roots
    fetch(`${API_BASE}/projects/${projectId}/fs`)
      .then((r) => r.json())
      .then((data) => {
        setRoots(data.items || []);
        setChildrenMap(new Map());
        setExpanded(new Set());
      })
      .catch(() => {});
    // staged
    refreshStaged();
    // 検索クリア
    setQ(""); setQResults([]);
  }, [projectId]);

  // ----------- 自動スクロール -----------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ----------- 候補ポップ位置追従 -----------
  useEffect(() => {
    const handler = () => recalcSuggestPosition();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [showSuggest]);

  // ----------- 右クリックメニューの外側クリックで閉じる -----------
  useEffect(() => {
    const close = () => setCtx((c) => ({ ...c, show: false }));
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, []);

  // ----------- アンマウント時に EventSource を閉じる -----------
  useEffect(() => {
    return () => {
      try { esRef.current?.close?.(); } catch {}
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

  // 送信（非ストリーム）
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
      if (data?.meta?.require_approval) {
        // 生成されたら pending を再読込
        refreshStaged();
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  // 送信（SSEストリーム）
  const sendPromptStream = async () => {
    const prompt = input.trim();
    if (!prompt || !projectId || loading) return;
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text: prompt, projectId }]);
    setInput(""); resetTextareaHeight(textRef.current); setShowSuggest(false);

    const assistantIndex = messages.length + 1; // 直後にassistantメッセージが入る想定
    setMessages((m) => [...m, { role: "assistant", text: "", meta: null }]);

    try {
      const url = new URL(`${API_BASE}/ask/stream`);
      url.searchParams.set("project_id", projectId);
      url.searchParams.set("prompt", prompt);

      // 既存接続があれば閉じる
      try { esRef.current?.close?.(); } catch {}

      const es = new EventSource(url.toString(), { withCredentials: false });
      esRef.current = es;

      es.addEventListener("open", () => {
        // noop
      });

      es.addEventListener("status", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          // statusはUI反映控えめでもOK（必要なら messages[assistantIndex] に追記）
        } catch {}
      });

      es.addEventListener("chunk", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const t = data?.text ?? "";
          if (!t) return;
          setMessages((m) => {
            const next = m.slice();
            const idx = assistantIndex;
            if (next[idx]) {
              next[idx] = { ...next[idx], text: (next[idx].text || "") + t };
            }
            return next;
          });
        } catch {}
      });

      es.addEventListener("file_written", (ev) => {
        // 生成ファイルを検出 → Staged一覧を更新
        refreshStaged();
        // 画面にも小さく反映 & トースト
        try {
          const data = JSON.parse(ev.data);
          const path = data?.path || "";
          pushToast({ type: "info", title: "File written", msg: path });
          setMessages((m) => {
            const next = m.slice();
            const idx = assistantIndex;
            if (next[idx]) {
              next[idx] = { ...next[idx], text: (next[idx].text || "") + `\n\n✅ wrote ${path}` };
            }
            return next;
          });
        } catch {}
      });

      es.addEventListener("done", (ev) => {
        try { es.close(); } catch {}
        esRef.current = null;
        setLoading(false);
        try {
          const data = JSON.parse(ev.data);
          // meta 相当の情報は /projects/{id} で取れるので省略
        } catch {}
      });

      es.addEventListener("error", (ev) => {
        try { es.close(); } catch {}
        esRef.current = null;
        setLoading(false);
        try {
          const data = JSON.parse(ev.data);
          setMessages((m) => [...m, { role: "assistant", text: `Error: ${data?.message || "stream error"}` }]);
          pushToast({ type: "error", title: "Stream error", msg: String(data?.message || "") });
        } catch {
          setMessages((m) => [...m, { role: "assistant", text: `Stream error` }]);
          pushToast({ type: "error", title: "Stream error", msg: "" });
        }
      });
    } catch (e) {
      setLoading(false);
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${e.message}` }]);
      pushToast({ type: "error", title: "Stream setup failed", msg: String(e.message || e) });
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

  const clearAll = () => {
    setMessages([]); setInput(""); resetTextareaHeight(textRef.current); setShowSuggest(false);
  };

  // 文字列挿入（キャレット）
  const insertAtCaret = (token) => {
    const el = textRef.current; if (!el) return;
    const start = el.selectionStart ?? input.length; const end = el.selectionEnd ?? input.length;
    const before = input.slice(0, start); const after = input.slice(end);
    const sepBefore = before && !/\s$/.test(before) ? " " : "";
    const sepAfter  = after  && !/^\s/.test(after)  ? " " : "";
    const next = `${before}${sepBefore}${token}${sepAfter}${after}`;
    setInput(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = (before + sepBefore + token).length;
      el.selectionStart = el.selectionEnd = pos;
      autoResize(el);
    });
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

  // ----------- Staged: 取得 -----------
  async function refreshStaged() {
    if (!projectId) return;
    setStagedBusy(true);
    try {
      const pj = await fetch(`${API_BASE}/projects/${projectId}`).then(r => r.json());
      const writeRoot = pj?.write_dir; // output_pending or write_dir
      if (!writeRoot) { setStaged([]); setStagedBusy(false); return; }

      const all = [];
      // 再帰的に掘る
      async function walk(rel) {
        const r = await fetch(`${API_BASE}/projects/${projectId}/fs?path=${encodeURIComponent(rel)}`);
        const data = await r.json();
        const items = data.items || [];
        for (const it of items) {
          if (it.type === "dir") await walk(it.rel);
          else all.push(it);
        }
      }
      await walk(writeRoot);
      setStaged(all);
    } catch {
      setStaged([]);
    } finally {
      setStagedBusy(false);
    }
  }

  // ----------- Staged: Diff -----------
  async function openStagedDiff(rel) {
    setSelectedStaged(rel);
    setStagedDiff(""); setStagedErr("");
    try {
      const u = new URL(`${API_BASE}/projects/${projectId}/diff`);
      u.searchParams.set("from_rel", rel);
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setStagedDiff(data?.diff || "(no diff)");
    } catch (e) {
      setStagedErr(String(e.message || e));
    }
  }
  const closeStagedDiff = () => { setSelectedStaged(null); setStagedDiff(""); setStagedErr(""); };

  // ----------- Staged: Approve / Reject -----------
  async function approveStaged(rel) {
    setStagedPending((m) => ({ ...m, [rel]: "approve" }));
    try {
      const r = await fetch(`${API_BASE}/projects/${projectId}/promote`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ project_id: projectId, from_rel: rel, overwrite: true })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      pushToast({ type: "success", title: "Approved", msg: rel });
      setFlash((f) => ({ ...f, [rel]: "approved" }));
      setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[rel]; return n; }), 1800);
      await refreshStaged();
      setSelectedStaged(null); setStagedDiff("");
    } catch (e) {
      pushToast({ type: "error", title: "Approve failed", msg: String(e.message || e) });
    } finally {
      setStagedPending((m) => { const n = { ...m }; delete n[rel]; return n; });
    }
  }

  async function rejectStaged(rel) {
    if (!confirm(`Reject this staged file?\n${rel}`)) return;
    setStagedPending((m) => ({ ...m, [rel]: "reject" }));
    try {
      const u = new URL(`${API_BASE}/projects/${projectId}/staged`);
      u.searchParams.set("path", rel);
      const r = await fetch(u, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      pushToast({ type: "success", title: "Rejected", msg: rel });
      setFlash((f) => ({ ...f, [rel]: "rejected" }));
      setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[rel]; return n; }), 1800);
      await refreshStaged();
      setSelectedStaged(null); setStagedDiff("");
    } catch (e) {
      pushToast({ type: "error", title: "Reject failed", msg: String(e.message || e) });
    } finally {
      setStagedPending((m) => { const n = { ...m }; delete n[rel]; return n; });
    }
  }

  // ----------- Render -----------
  return (
    <div style={styles.container}>
      {/* アクセシビリティ: ライブ領域（トースト読み上げ） */}
      <div aria-live="polite" style={styles.srOnly}>
        {toasts.length ? `${toasts[toasts.length-1].title}: ${toasts[toasts.length-1].msg}` : ""}
      </div>

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
            <button style={{ ...styles.tabBtn, ...(activeSideTab === "staged" ? styles.tabActive : null) }} onClick={() => { setActiveSideTab("staged"); refreshStaged(); }}>Staged</button>
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

          {activeSideTab === "staged" && (
            <>
              <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:8 }}>
                <button style={styles.clearSmall} onClick={refreshStaged}>{stagedBusy ? "Loading…" : "Refresh"}</button>
                <span style={{ fontSize:12, opacity:.7 }}>{staged.length ? `${staged.length} file(s)` : "No staged files"}</span>
                {!!staged.length && (
                  <button
                    style={{ ...styles.clearSmall, marginLeft: "auto" }}
                    onClick={async () => {
                      if (!confirm(`Approve all ${staged.length} file(s)?`)) return;
                      for (const it of staged) { await approveStaged(it.rel); }
                    }}>
                    Approve All
                  </button>
                )}
              </div>
              <div style={styles.tree}>
                {staged.map(it => (
                  <div
                    key={it.rel}
                    style={{
                      ...styles.searchRow,
                      ...(flash[it.rel] === "approved" ? styles.flashApproved :
                         flash[it.rel] === "rejected" ? styles.flashRejected : null)
                    }}>
                    <span>📄</span>
                    <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{it.rel}</span>
                    <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
                      <button
                        style={{ ...styles.miniBtn, ...(stagedPending[it.rel] ? styles.miniBtnDisabled : null) }}
                        onClick={() => openStagedDiff(it.rel)}
                        disabled={!!stagedPending[it.rel]}>
                        Diff
                      </button>
                      <button
                        style={{ ...styles.miniBtn, ...(stagedPending[it.rel] ? styles.miniBtnDisabled : null) }}
                        onClick={() => approveStaged(it.rel)}
                        disabled={!!stagedPending[it.rel]}>
                        {stagedPending[it.rel] === "approve" ? <Spinner /> : "Approve"}
                      </button>
                      <button
                        style={{ ...styles.miniBtn, ...(stagedPending[it.rel] ? styles.miniBtnDisabled : null) }}
                        onClick={() => rejectStaged(it.rel)}
                        disabled={!!stagedPending[it.rel]}>
                        {stagedPending[it.rel] === "reject" ? <Spinner /> : "Reject"}
                      </button>
                    </div>
                  </div>
                ))}
                {!staged.length && <div style={{ opacity:.6, fontSize:12 }}>No items</div>}
              </div>
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
              placeholder="例）@input/discussion.txt を @guideline/議事録.txt に沿って要約して @output に保存。"
              style={styles.textarea}
              rows={1}
            />
            <button onClick={sendPrompt} disabled={loading || !input.trim() || !projectId} aria-label="Send"
              style={{ ...styles.sendIconBtn, ...(loading || !input.trim() || !projectId ? styles.sendIconBtnDisabled : null) }}>
              <SendIcon />
            </button>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={sendPromptStream} disabled={loading || !input.trim() || !projectId} style={styles.secondary}>Stream</button>
            <button onClick={clearAll} style={styles.secondary}>Clear</button>
          </div>
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

      {/* Diffモーダル */}
      {selectedStaged && (
        <div style={styles.modalBackdrop} onClick={closeStagedDiff}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <div style={{ fontWeight: 600 }}>Diff: {selectedStaged}</div>
              <button style={styles.modalClose} onClick={closeStagedDiff}>✕</button>
            </div>
            <div style={styles.modalBody}>
              {stagedErr && <div style={{ color:"crimson", marginBottom:8 }}>{stagedErr}</div>}
              {!stagedErr && !stagedDiff && <div>Loading…</div>}
              {!stagedErr && stagedDiff && (
                <pre style={styles.codeBlock}><code>{stagedDiff}</code></pre>
              )}
            </div>
            <div style={styles.modalFoot}>
              <button
                style={{ ...styles.secondary, ...(stagedPending[selectedStaged] ? styles.miniBtnDisabled : null) }}
                onClick={() => approveStaged(selectedStaged)}
                disabled={!!stagedPending[selectedStaged]}>
                {stagedPending[selectedStaged] === "approve" ? <Spinner /> : "Approve"}
              </button>
              <button
                style={{ ...styles.secondary, ...(stagedPending[selectedStaged] ? styles.miniBtnDisabled : null) }}
                onClick={() => rejectStaged(selectedStaged)}
                disabled={!!stagedPending[selectedStaged]}>
                {stagedPending[selectedStaged] === "reject" ? <Spinner /> : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div style={styles.toastContainer}>
        {toasts.map(t => (
          <div key={t.id} style={{
            ...styles.toast,
            ...(t.type === "success" ? styles.toastSuccess :
               t.type === "error"   ? styles.toastError   :
               t.type === "info"    ? styles.toastInfo    : null)
          }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{t.title}</div>
            <div style={{ fontSize: 12, opacity: .9 }}>{t.msg}</div>
          </div>
        ))}
      </div>
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
function Spinner() { return <span style={styles.spinner} aria-hidden="true" />; }
function formatBytes(n) { if (n < 1024) return `${n} B`; const kb = n / 1024; if (kb < 1024) return `${kb.toFixed(1)} KB`; const mb = kb / 1024; return `${mb.toFixed(1)} MB`; }

// --- styles ---
const styles = {
  container: { height: "100vh", display: "grid", gridTemplateRows: "48px 1fr", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "0 12px", borderBottom: "1px solid #eee", background: "#111827", color: "#e5e7eb" },
  main: { display: "grid", gridTemplateColumns: "1fr 340px", gridTemplateRows: "1fr auto", gap: 12, padding: 12 },
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
  miniBtnDisabled: { opacity: .5, cursor: "not-allowed" },

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

  // Flash
  flashApproved: { background: "rgba(16,185,129,.12)", transition: "background .6s" },
  flashRejected: { background: "rgba(239,68,68,.12)", transition: "background .6s" },

  // Spinner
  spinner: {
    display: "inline-block",
    width: 14, height: 14,
    borderRadius: "50%",
    border: "2px solid rgba(0,0,0,.2)",
    borderTopColor: "rgba(0,0,0,.6)",
    animation: "spin 0.7s linear infinite"
  },

  // Toasts
  toastContainer: { position: "fixed", right: 16, bottom: 16, display: "grid", gap: 8, zIndex: 3000 },
  toast: { minWidth: 220, maxWidth: 360, padding: "10px 12px", borderRadius: 10, background: "#111827", color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,.2)", border: "1px solid rgba(255,255,255,.08)" },
  toastSuccess: { background: "#065f46" },
  toastError: { background: "#7f1d1d" },
  toastInfo: { background: "#1f2937" },

  // screen-reader only
  srOnly: { position: "absolute", width: 1, height: 1, margin: -1, border: 0, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)" },
};
