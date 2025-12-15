#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as https from "https";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(
            "Error: DROPBOX_APP_KEY and DROPBOX_APP_SECRET environment variables are required."
        );
        console.error("Please set them before starting the server.");
        process.exit(1);
    }
    return value;
}

// Dropbox App credentials
const APP_KEY = requireEnv("DROPBOX_APP_KEY");
const APP_SECRET = requireEnv("DROPBOX_APP_SECRET");

// Token storage file path
const TOKEN_FILE_PATH =
    process.env.DROPBOX_TOKEN_FILE ?? path.join(os.homedir(), ".dropbox_token");

interface DropboxFileMetadata {
    name: string;
    path_lower: string;
    path_display: string;
    id: string;
}

interface DropboxEntry {
    ".tag": "file" | "folder";
    name: string;
    path_lower: string;
    path_display: string;
    id: string;
}

interface DropboxListFolderResponse {
    entries: DropboxEntry[];
    cursor: string;
    has_more: boolean;
}

interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
}

function getAuthUrl(): string {
    return `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline`;
}

async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;
    try {
        if (platform === "darwin") {
            await execFileAsync("open", [url]);
            return;
        }
        if (platform === "win32") {
            // Avoid invoking a shell on Windows. Ask user to open manually.
            throw new Error("Automatic browser open is not supported on Windows; open manually.");
        }
        await execFileAsync("xdg-open", [url]);
    } catch {
        console.error(`Please open this URL manually: ${url}`);
    }
}

function saveRefreshToken(token: string): void {
    fs.writeFileSync(TOKEN_FILE_PATH, token, { encoding: "utf-8", mode: 0o600 });
}

function loadRefreshToken(): string | null {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
        return fs.readFileSync(TOKEN_FILE_PATH, "utf-8").trim();
    }
    return null;
}

async function getRefreshToken(): Promise<string> {
    // First check environment variable
    let refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

    // Then check saved token file
    if (!refreshToken) {
        refreshToken = loadRefreshToken() ?? undefined;
    }

    // IMPORTANT: MCP servers communicate over stdio; do not prompt for input here.
    // If we block on stdin, the MCP transport hangs.
    if (!refreshToken) {
        throw new Error(
            [
                "Dropbox refresh token is not configured.",
                "Set DROPBOX_REFRESH_TOKEN (recommended) or create a token file.",
                "You can also use MCP tools:",
                "- dropbox_auth_get_url (open the URL, authorize, copy the code)",
                "- dropbox_auth_exchange_code (exchange code -> refresh token; optionally save)",
            ].join("\n")
        );
    }

    return refreshToken;
}

function makeRequest<T>(
    hostname: string,
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: string | Buffer
): Promise<T> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname,
            path,
            method,
            headers,
        };

        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const data = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data) as T);
                    } catch {
                        resolve(data as unknown as T);
                    }
                } else {
                    reject(new Error(`Request failed: ${res.statusCode} - ${data}`));
                }
            });
        });

        req.setTimeout(30_000, () => {
            req.destroy(new Error("Request timed out"));
        });

        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

async function getAccessToken(): Promise<string> {
    const refreshToken = await getRefreshToken();

    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: APP_KEY,
        client_secret: APP_SECRET,
    }).toString();

    const response = await makeRequest<TokenResponse>(
        "api.dropboxapi.com",
        "/oauth2/token",
        "POST",
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body).toString(),
        },
        body
    );

    return response.access_token;
}

async function exchangeCodeForToken(
    authCode: string
): Promise<{ access_token: string; refresh_token: string }> {
    const body = new URLSearchParams({
        code: authCode,
        grant_type: "authorization_code",
        client_id: APP_KEY,
        client_secret: APP_SECRET,
    }).toString();

    const response = await makeRequest<{
        access_token: string;
        refresh_token: string;
    }>(
        "api.dropboxapi.com",
        "/oauth2/token",
        "POST",
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body).toString(),
        },
        body
    );

    return response;
}

// Escape non-ASCII characters for HTTP header safety
function escapeNonAscii(str: string): string {
    return str.replace(/[\u007f-\uffff]/g, (c) => {
        return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
    });
}

async function downloadFile(filePath: string): Promise<string> {
    const accessToken = await getAccessToken();

    const result = await makeRequest<string>(
        "content.dropboxapi.com",
        "/2/files/download",
        "POST",
        {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": escapeNonAscii(JSON.stringify({ path: filePath })),
            "Content-Type": "text/plain; charset=utf-8",
        }
    );

    return result;
}

async function uploadFile(
    filePath: string,
    content: string
): Promise<DropboxFileMetadata> {
    const accessToken = await getAccessToken();

    const result = await makeRequest<DropboxFileMetadata>(
        "content.dropboxapi.com",
        "/2/files/upload",
        "POST",
        {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": escapeNonAscii(
                JSON.stringify({
                    path: filePath,
                    mode: "add",
                    autorename: true,
                    mute: false,
                })
            ),
            "Content-Type": "application/octet-stream",
        },
        content
    );

    return result;
}

async function listFolder(folderPath: string): Promise<DropboxEntry[]> {
    const accessToken = await getAccessToken();

    const body = JSON.stringify({
        path: folderPath === "/" ? "" : folderPath,
        recursive: false,
        include_media_info: false,
        include_deleted: false,
        include_has_explicit_shared_members: false,
    });

    const result = await makeRequest<DropboxListFolderResponse>(
        "api.dropboxapi.com",
        "/2/files/list_folder",
        "POST",
        {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body
    );

    return result.entries;
}

function generateFileName(title: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const timestamp = `${year}${month}${day}${hours}${minutes}`;
    const sanitizedTitle = title.replace(/[/\\?%*:|"<>]/g, "-");
    return `${timestamp}-${sanitizedTitle}.md`;
}

// Create MCP Server
const server = new Server(
    {
        name: "dropbox-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "dropbox_auth_status",
                description:
                    "Check whether Dropbox refresh token is configured (env or token file)",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "dropbox_auth_get_url",
                description:
                    "Get Dropbox OAuth authorization URL (optionally opens browser on the MCP host)",
                inputSchema: {
                    type: "object",
                    properties: {
                        openBrowser: {
                            type: "boolean",
                            description:
                                "If true, attempt to open the authorization URL in a browser on the MCP host",
                        },
                    },
                },
            },
            {
                name: "dropbox_auth_exchange_code",
                description:
                    "Exchange an authorization code for tokens. Optionally save refresh token to token file.",
                inputSchema: {
                    type: "object",
                    properties: {
                        authCode: {
                            type: "string",
                            description: "Authorization code from Dropbox OAuth redirect",
                        },
                        save: {
                            type: "boolean",
                            description:
                                "If true (default), save refresh token to token file for future use",
                        },
                    },
                    required: ["authCode"],
                },
            },
            {
                name: "dropbox_download",
                description: "Download a file from Dropbox",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: {
                            type: "string",
                            description: "The path to the file in Dropbox (e.g., /path/to/file.txt)",
                        },
                    },
                    required: ["filePath"],
                },
            },
            {
                name: "dropbox_upload",
                description: "Upload a file to Dropbox",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: {
                            type: "string",
                            description: "The destination path in Dropbox (e.g., /path/to/file.txt)",
                        },
                        content: {
                            type: "string",
                            description: "The content to upload",
                        },
                    },
                    required: ["filePath", "content"],
                },
            },
            {
                name: "dropbox_generate_filename",
                description: "Generate a filename with timestamp prefix for Obsidian notes",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            description: "The title for the note",
                        },
                    },
                    required: ["title"],
                },
            },
            {
                name: "dropbox_list_folder",
                description: "List files and folders in a Dropbox directory",
                inputSchema: {
                    type: "object",
                    properties: {
                        folderPath: {
                            type: "string",
                            description: "The path to the folder in Dropbox (e.g., /path/to/folder)",
                        },
                    },
                    required: ["folderPath"],
                },
            },
        ],
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const { name, arguments: args } = request.params;

        switch (name) {
            case "dropbox_auth_status": {
                const envToken = (process.env.DROPBOX_REFRESH_TOKEN ?? "").trim();
                const fileToken = (loadRefreshToken() ?? "").trim();
                const configured = Boolean(envToken || fileToken);
                const source = envToken
                    ? "env:DROPBOX_REFRESH_TOKEN"
                    : fileToken
                        ? `file:${TOKEN_FILE_PATH}`
                        : "none";

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ configured, source }, null, 2),
                        },
                    ],
                };
            }

            case "dropbox_auth_get_url": {
                const { openBrowser: shouldOpenBrowser } =
                    (args as { openBrowser?: boolean }) ?? {};
                const url = getAuthUrl();
                if (shouldOpenBrowser) {
                    await openBrowser(url);
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: url,
                        },
                    ],
                };
            }

            case "dropbox_auth_exchange_code": {
                const { authCode, save } = args as {
                    authCode: string;
                    save?: boolean;
                };
                const tokens = await exchangeCodeForToken(authCode);
                const refreshToken = tokens.refresh_token;
                if (!refreshToken) {
                    throw new Error(
                        "Dropbox did not return a refresh_token. Ensure you requested offline access (token_access_type=offline) and the app is configured correctly."
                    );
                }

                const shouldSave = save !== false;
                if (shouldSave) {
                    saveRefreshToken(refreshToken);
                }
                process.env.DROPBOX_REFRESH_TOKEN = refreshToken;

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    refresh_token: refreshToken,
                                    saved: shouldSave,
                                    tokenFile: shouldSave ? TOKEN_FILE_PATH : undefined,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            case "dropbox_download": {
                const { filePath } = args as { filePath: string };
                const content = await downloadFile(filePath);
                return {
                    content: [
                        {
                            type: "text",
                            text: content,
                        },
                    ],
                };
            }

            case "dropbox_upload": {
                const { filePath, content } = args as {
                    filePath: string;
                    content: string;
                };
                const result = await uploadFile(filePath, content);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            }

            case "dropbox_generate_filename": {
                const { title } = args as { title: string };
                const filename = generateFileName(title);
                return {
                    content: [
                        {
                            type: "text",
                            text: filename,
                        },
                    ],
                };
            }

            case "dropbox_list_folder": {
                const { folderPath } = args as { folderPath: string };
                const entries = await listFolder(folderPath);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(entries, null, 2),
                        },
                    ],
                };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${errorMessage}`,
                },
            ],
            isError: true,
        };
    }
});

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Dropbox MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
