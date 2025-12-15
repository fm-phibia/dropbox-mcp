# Dropbox MCP Server

Dropbox MCP (Model Context Protocol) サーバーは、AI アシスタントが Dropbox のファイル操作を行えるようにするツールです。

## 機能

### 認証関連ツール

- **dropbox_auth_status**: 現在の認証状態を確認（環境変数またはトークンファイルの設定状況）
- **dropbox_auth_get_url**: OAuth認可URLを取得（オプションでブラウザを自動起動）
- **dropbox_auth_exchange_code**: 認可コードをリフレッシュトークンに交換（デフォルトでトークンファイルに保存）

### ファイル操作ツール

- **dropbox_download**: Dropbox からファイルをダウンロード
- **dropbox_upload**: Dropbox にファイルをアップロード
- **dropbox_list_folder**: Dropbox のフォルダ内のファイルとサブフォルダをリスト表示
- **dropbox_generate_filename**: タイムスタンプ付きのファイル名を生成（Obsidian ノート用）

### 認証の仕組み

**重要**: MCPサーバーはstdioでプロトコル通信するため、サーバー側で対話入力（ターミナルでコード入力を待つ等）はできません。認証が未設定の場合、ツール呼び出しはエラーで返ります。

MCPのツールとして以下を使って認証します:

1. `dropbox_auth_get_url` で認可URLを取得（必要なら `openBrowser: true` も可）
2. ブラウザで許可し、表示された authorization code をコピー
3. `dropbox_auth_exchange_code` に `authCode` を渡して refresh token を取得（デフォルトでトークンファイルに保存）

トークンファイルの保存先は `DROPBOX_TOKEN_FILE` 環境変数で上書きできます（未指定なら `~/.dropbox_token`）。

## インストール

### npmからインストール（推奨）

```bash
npm install -g @fm-phibia/dropbox-mcp
```

### ソースからビルド

#### 1. 依存関係のインストール

```bash
npm install
```

#### 2. ビルド

```bash
npm run build
```

## セットアップ

### 1. Dropbox App の作成

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) にアクセス
2. 「Create app」をクリック
3. 以下を選択：
   - **API**: Scoped access
   - **Access type**: Full Dropbox または App folder（用途に応じて）
   - **App name**: 任意の名前を入力
4. 作成後、「Settings」タブで以下を確認：
   - **App key** (DROPBOX_APP_KEY)
   - **App secret** (DROPBOX_APP_SECRET)
5. 「Permissions」タブで必要な権限を設定（例: `files.metadata.read`, `files.content.read`, `files.content.write`）

### 2. 環境変数の設定

以下の環境変数を設定してください：

```bash
export DROPBOX_APP_KEY="your-app-key"
export DROPBOX_APP_SECRET="your-app-secret"
export DROPBOX_REFRESH_TOKEN="your-refresh-token"  # 初回認証後に設定
```

### 3. 初回認証

初回実行時に Dropbox の OAuth 認証が必要です。

MCP ツールを使用して認証を行います：

1. `dropbox_auth_get_url` ツールで認可URLを取得
2. ブラウザで認可し、表示された authorization code をコピー
3. `dropbox_auth_exchange_code` ツールで認可コードをリフレッシュトークンに交換
4. 取得したリフレッシュトークンを `DROPBOX_REFRESH_TOKEN` 環境変数に設定

または、トークンファイル（`~/.dropbox_token`）に保存することもできます。

## 使用方法

### Claude Desktop での使用

`claude_desktop_config.json` に以下を追加：

#### グローバルインストールした場合

```json
{
  "mcpServers": {
    "dropbox": {
      "command": "dropbox-mcp",
      "env": {
        "DROPBOX_APP_KEY": "your-app-key",
        "DROPBOX_APP_SECRET": "your-app-secret",
        "DROPBOX_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

#### ソースからビルドした場合

```json
{
  "mcpServers": {
    "dropbox": {
      "command": "node",
      "args": [
        "/path/to/dropbox-mcp/build/index.js"
      ],
      "env": {
        "DROPBOX_APP_KEY": "your-app-key",
        "DROPBOX_APP_SECRET": "your-app-secret",
        "DROPBOX_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

### 利用可能なツール

#### 認証関連

##### dropbox_auth_status

現在の認証状態を確認します。

```json
{}
```

返り値の例:
```json
{
  "configured": true,
  "source": "env:DROPBOX_REFRESH_TOKEN"
}
```

##### dropbox_auth_get_url

OAuth認可URLを取得します。

```json
{
  "openBrowser": true
}
```

##### dropbox_auth_exchange_code

認可コードをリフレッシュトークンに交換します。

```json
{
  "authCode": "your-authorization-code",
  "save": true
}
```

#### ファイル操作

##### dropbox_download

Dropbox からファイルをダウンロードします。

```json
{
  "filePath": "/path/to/file.txt"
}
```

##### dropbox_upload

Dropbox にファイルをアップロードします。

```json
{
  "filePath": "/path/to/file.txt",
  "content": "ファイルの内容"
}
```

##### dropbox_list_folder

フォルダ内のファイルとサブフォルダをリスト表示します。

```json
{
  "folderPath": "/path/to/directories"
}
```

返り値の例:
```json
[
  {
    ".tag": "folder",
    "name": "Daily",
    "path_lower": "/path/to/directories/daily",
    "path_display": "/path/to/directories/Daily",
    "id": "id:..."
  },
  {
    ".tag": "file",
    "name": "example.md",
    "path_lower": "/path/to/directories/example.md",
    "path_display": "/path/to/directories/example.md",
    "id": "id:..."
  }
]
```

##### dropbox_generate_filename

タイムスタンプ付きのファイル名を生成します（形式: `YYYYMMDDHHmm-title.md`）。

```json
{
  "title": "My Note"
}
```

例：`202412151445-My-Note.md`

## セキュリティ

**重要な注意事項:**

- **App Key と App Secret は機密情報です**。公開リポジトリにコミットしないでください
- Dropbox のリフレッシュトークンは `.dropbox_token` ファイルまたは環境変数に保存されます
- `.dropbox_token` ファイルは `.gitignore` に追加することを推奨します（デフォルトで含まれています）
- アクセストークンは自動的に更新されます
- 環境変数を使用する場合は、システムの環境変数設定または `.env` ファイル（`.gitignore` に追加）を使用してください

## トラブルシューティング

### 認証エラー

リフレッシュトークンをリセットするには：

```bash
rm .dropbox_token
```

次回実行時に再度認証が求められます。

### ビルドエラー

TypeScript の設定を確認してください：

```bash
npm run build
```

## 開発・テスト

### スタンドアロンスクリプトでの動作確認

MCP サーバーを起動せずに、Dropbox API を直接呼び出してテストすることができます。

`test-download.js` を使用して、Dropbox からファイルをリスト表示およびダウンロードできます：

```bash
node test-download.js
```

このスクリプトは以下を実行します：

1. `.dropbox_token` ファイルからリフレッシュトークンを読み込み
2. アクセストークンを取得
3. 指定されたフォルダ（デフォルト: `/アプリ/remotely-save/note`）のファイルをリスト表示
4. 最初のファイルをダウンロードして内容を表示

スクリプトを編集することで、異なるフォルダやファイルをテストできます。

### MCP サーバーとしてテスト

Claude Desktop や Claude Code で使用する前に、ローカルでテストすることもできます：

```bash
npm run build
node build/index.js
```

MCP サーバーは stdio で通信するため、直接的な対話はできません。Claude Desktop や Claude Code からの接続が必要です。

## ライセンス

ISC
