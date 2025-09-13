# Claude Code Demo (Web UI × FastAPI)

React 製の Web UI から **Claude Code SDK** を使い、プロジェクト配下のファイルを参照しつつ要約を **@output** に保存できます。  
右上でプロジェクトを切替、左サイドでファイルツリー/検索、入力欄では **`@input/...` `@guideline/...` `@output/...`** の @メンション指定が可能。

- ✅ **Bルート（特化）**: `@input`（任意で `@guideline`）を読み、要約を **`@output` に保存**（サーバ側で必ず保存）
- ➡️ **フォールバック**: それ以外は SDK の **Read / Write / Bash** による通常エージェント実行

---

## 構成（本リポジトリ）
```
.
├─ claude-code-demo/
│  └─ claude-ui/            # ← フロントエンド（Vite + React）
│     ├─ src/
│     │  ├─ App.jsx / App.css / main.jsx / index.css
│     │  └─ assets/
│     ├─ public/
│     ├─ package.json / package-lock.json / vite.config.js
│     ├─ index.html
│     └─ .env.local         # VITE_BACKEND_URL を設定（後述）
└─ server/                  # ← バックエンド（FastAPI）
   ├─ app.py
   ├─ requirements.txt
   ├─ projects/
   │  ├─ projectA/
   │  │  ├─ manifest.json
   │  │  ├─ guideline/      # 読取専用
   │  │  │  └─ 報告テンプレ.md
   │  │  ├─ input/          # 読取専用
   │  │  │  └─ meeting.md
   │  │  └─ output/         # 書込先（成果物コミット済み）
   │  │     └─ meeting-summary.md
   │  └─ projectB/
   │     ├─ manifest.json
   │     ├─ guideline/
   │     │  └─ reporting.md
   │     ├─ input/
   │     │  └─ weekly.md
   │     └─ output/
   │        └─ weekly-summary.md
   └─ .env                  # ※コミットしない。API キーを置く用（任意）
```

---

## 前提
- **Python 3.10+**（推奨 3.11）
- **Node.js 18+**（推奨 20）
- **Anthropic API Key**（環境変数 `ANTHROPIC_API_KEY` で利用）

---

## セットアップ

### 1) バックエンド（FastAPI）
```bash
cd server
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scriptsctivate
pip install -U pip
pip install -r requirements.txt                      # fastapi / uvicorn / claude-code-sdk など
# API キー（推奨: 環境変数で）
export ANTHROPIC_API_KEY="your-key"
# ※ .env を使う場合は server/.env に ANTHROPIC_API_KEY=... を記載（コミットしない）

# 起動
uvicorn app:app --reload
# → http://127.0.0.1:8000
```

### 2) フロントエンド（Vite + React）
```bash
cd claude-code-demo/claude-ui
npm i
# バックエンドのURLを教える
echo 'VITE_BACKEND_URL=http://127.0.0.1:8000' > .env.local
npm run dev
# → http://127.0.0.1:5173
```

---

## クイックスタート（3分）

1. バックエンドを `server` で起動、フロントを `claude-code-demo/claude-ui` で起動  
2. 右上のプロジェクト選択で **Project A** を選択  
3. 入力欄に次を貼って送信（**Enter=改行 / ⌘ or Ctrl + Enter=送信**）
   ```
   @input/meeting.md を要約して、@guideline/報告テンプレ.md を参考に @output に保存してください
   ```
4. 返答に `✅ DONE: @output/meeting-summary.md` と表示 → 左のツリーで `output/` をクリックしてプレビュー  
   （**Project B** でも `@input/weekly.md` + `@guideline/reporting.md` で同様に確認できます）

---

## 使い方の要点

### ルーティング
- **Bルート（要約→保存）** に入る条件（両方必要）
  - プロンプトに **「要約 / まとめ / summarize / summary」** のいずれかが含まれる
  - **`@input/...` と `@output/...`** の両方が含まれる（`@guideline/...` は任意）
- 条件外は **フォールバック**（SDKの Read/Write/Bash）

### サンプル
```
✅ @input/meeting.md を要約して @output/meeting-summary.md に保存
✅ @guideline/報告テンプレ.md に従い @input/meeting.md をまとめ、@output に保存
➡️ @input/weekly.md をHTMLに変換し @output/weekly.html を書いて     # 変換系→フォールバック
➡️ @input/users.csv から上位10件を抽出して表にして                 # 抽出系→フォールバック
```

### UI Tips
- **@メンション**: `@` でファイルピッカー。右クリック「コピー @メンション」  
- **プレビュー**: テキストはその場表示（~200KB）  
- **送信後**: 自動スクロール / 入力欄は自動で高さ拡張  
- **Markdown**: アシスタントの返答は Markdown 表示

---

## API（参考）
- `GET /projects` … プロジェクト一覧  
- `GET /projects/{id}` … 詳細（aliases, read_dirs, write_dir）  
- `GET /projects/{id}/fs?path=...` … ファイルツリー  
- `GET /projects/{id}/search?q=...` … クイック検索  
- `GET /projects/{id}/file?path=...` … プレビュー（テキスト）  
- `POST /ask` … チャット実行  
  - Bルート: サーバ側で **read→generate→write** を実行し `@output/...` に保存  
  - フォールバック: SDK の Read/Write/Bash を許可

---

## 注意事項
- `server/.env` は **コミットしない**でください（`.gitignore` 推奨）。  
- うっかり秘密をコミットした場合は履歴から削除して再 push（GitHub の Push Protection に従う）。  
- CORS エラー時は `server/app.py` の `allow_origins` に `http://localhost:5173` が含まれているか確認。

---

## ライセンス
Demo purpose. 必要に応じて MIT/Apache-2.0 などを設定してください。
