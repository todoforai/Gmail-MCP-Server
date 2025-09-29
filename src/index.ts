#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from 'googleapis';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import open from 'open';
import os from 'os';
import { 
    SendEmailSchema, 
    ReadEmailSchema, 
    SearchEmailsSchema, 
    ModifyEmailSchema, 
    DeleteEmailSchema, 
    ListEmailLabelsSchema,
    CreateLabelSchema,
    UpdateLabelSchema,
    DeleteLabelSchema,
    GetOrCreateLabelSchema,
    BatchModifyEmailsSchema,
    BatchDeleteEmailsSchema,
    CreateFilterSchema,
    ListFiltersSchema,
    GetFilterSchema,
    DeleteFilterSchema,
    CreateFilterFromTemplateSchema,
    DownloadAttachmentSchema
} from "./schemas.js";

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let oauthKeys: any; // shared OAuth client config (web or installed)
let serverInstance: Server; // Store server instance for logging

// Centralized logging function - Use MCP notifications instead of console
async function logMessage(level: 'debug' | 'info' | 'warning' | 'error', message: string) {
    const logPrefix = `[gmail-mcp]`;
    const fullMessage = `${logPrefix} ${message}`;
    
    // Always log to console as fallback
    switch (level) {
        case 'debug':
            console.debug(fullMessage);
            break;
        case 'info':
            console.info(fullMessage);
            break;
        case 'warning':
            console.warn(fullMessage);
            break;
        case 'error':
            console.error(fullMessage);
            break;
        default:
            console.log(fullMessage);
    }
    
    // Also send as MCP notification if server is available
    if (serverInstance) {
        try {
            await serverInstance.notification({
                method: "notifications/message",
                params: {
                    level: level,
                    logger: "gmail-mcp",
                    data: fullMessage,  // Changed from 'message' to 'data'
                }
            });
        } catch (e) {
            // Ignore notification errors to avoid infinite loops
        }
    }
}

// Emit highly-visible startup diagnostics AFTER the server is connected
async function emitStartupDiagnostics() {
    await logMessage('error', `CREDENTIALS_PATH: ${CREDENTIALS_PATH}`);
    console.error(`[gmail-mcp] CREDENTIALS_PATH: ${CREDENTIALS_PATH}`);
}

// Configuration paths
const expandTilde = (p?: string) => {
    if (!p) return undefined;
    // Expand ~, ~/ and ~\ to home
    let expanded = p.replace(/^~(?=\/|\\|$)/, os.homedir());

    // Expand Windows-style %VAR%
    expanded = expanded.replace(/%([^%]+)%/g, (match, varName) => {
        const envVal = process.env[varName];
        if (envVal) return envVal;
        if (process.platform === 'win32' && varName.toUpperCase() === 'USERPROFILE') {
            const home = process.env.USERPROFILE || os.homedir() || ((process.env.HOMEDRIVE || '') + (process.env.HOMEPATH || ''));
            return home || match;
        }
        return match;
    });

    // Expand POSIX ${VAR} and $VAR
    expanded = expanded.replace(/\$\{([^}]+)\}/g, (m, varName) => process.env[varName] || m);
    expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, varName) => process.env[varName] || m);

    return expanded;
};

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = expandTilde(process.env.GMAIL_OAUTH_PATH) || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = expandTilde(process.env.GMAIL_CREDENTIALS_PATH) || path.join(CONFIG_DIR, 'credentials.json');


async function loadCredentials() {
    try {
        // Create config directory if it doesn't exist
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        // Check for OAuth keys in current directory first, then in config directory
        const localOAuthPath = path.join(process.cwd(), 'gcp-oauth.keys.json');

        if (fs.existsSync(localOAuthPath)) {
            // If found in current directory, copy to config directory
            fs.copyFileSync(localOAuthPath, OAUTH_PATH);
            await logMessage('info', 'OAuth keys found in current directory, copied to global config.');
        }

        let keysContent: any | undefined;

        if (fs.existsSync(OAUTH_PATH)) {
            keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
        } else {
            // Fetch keys from configured URL, defaulting to maintainer endpoint
            const url = process.env.GMAIL_OAUTH_URL || 'https://api.todofor.ai/gmail-oauth.json';
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                keysContent = await resp.json();
                if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
                fs.writeFileSync(OAUTH_PATH, JSON.stringify(keysContent));
                await logMessage('info', `OAuth keys fetched from ${url} and saved to global config.`);
            } catch (e) {
                console.error('Error fetching OAuth keys:', e);
                process.exit(1);
            }
        }

        const keys = (keysContent as any).installed || (keysContent as any).web;

        if (!keys) {
            console.error('Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.');
            process.exit(1);
        }

        oauthKeys = keys;

        const callback = process.argv[2] === 'auth' && process.argv[3] 
        ? process.argv[3] 
        : "http://localhost:3000/oauth2callback";

        oauth2Client = new OAuth2Client(
            keys.client_id,
            keys.client_secret,
            callback
        );

        if (fs.existsSync(CREDENTIALS_PATH)) {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            oauth2Client.setCredentials(credentials);
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        process.exit(1);
    }
}

async function authenticate() {
    // Determine requested callback (defaults to localhost:3000)
    const requestedCallback = process.argv[3] || "http://localhost:3000/oauth2callback";

    // Parse host, path, and preferred port
    let host = 'localhost';
    let pathName = '/oauth2callback';
    let preferredPort = 3000;
    try {
        const u = new URL(requestedCallback);
        host = u.hostname || 'localhost';
        pathName = u.pathname || '/oauth2callback';
        preferredPort = u.port ? parseInt(u.port) : 3000;
    } catch {
        // ignore, use defaults
    }

    // Create server and try to bind to preferred port, fallback to a free port if busy
    const server = http.createServer();
    const finalPort: number = await new Promise((resolve) => {
        const tryListen = (p: number) => {
            server.once('error', (err: any) => {
                if (err && err.code === 'EADDRINUSE') {
                    // fallback to random free port
                    tryListen(0);
                } else {
                    console.error('Failed to bind OAuth callback port:', err);
                    process.exit(1);
                }
            });
            server.listen(p, '127.0.0.1', () => {
                const addr = server.address();
                resolve(typeof addr === 'object' && addr ? addr.port : p);
            });
        };
        tryListen(preferredPort);
    });

    const finalCallback = `http://${host}:${finalPort}${pathName}`;

    // Recreate OAuth client with the final callback (may differ if port was busy)
    oauth2Client = new OAuth2Client(
        oauthKeys.client_id,
        oauthKeys.client_secret,
        finalCallback
    );

    console.log('Using OAuth callback:', finalCallback);

    return new Promise<void>((resolve, reject) => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: [
                'https://www.googleapis.com/auth/gmail.modify',
                'https://www.googleapis.com/auth/gmail.settings.basic'
            ],
        });

        console.log('Please visit this URL to authenticate:', authUrl);
        open(authUrl);

        server.on('request', async (req, res) => {
            if (!req.url?.startsWith(pathName)) return;

            const url = new URL(req.url, `http://${host}:${finalPort}`);
            const code = url.searchParams.get('code');

            if (!code) {
                res.writeHead(400);
                res.end('No code provided');
                reject(new Error('No code provided'));
                return;
            }

            try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens));

                res.writeHead(200);
                res.end('Authentication successful! You can close this window.');
                server.close();
                resolve();
            } catch (error) {
                res.writeHead(500);
                res.end('Authentication failed');
                reject(error);
            }
        });
    });
}

// Main function
async function main() {
    // Server implementation first so notifications are visible during credential loading
    const server = new Server({
        name: "gmail",
        version: "1.0.0",
        capabilities: {
            tools: {},
        },
    });
    serverInstance = server;

    await loadCredentials();

    if (process.argv[2] === 'auth') {
        await authenticate();
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    // Initialize Gmail API
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Tool handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "send_email",
                description: "Sends a new email",
                inputSchema: zodToJsonSchema(SendEmailSchema),
            },
            {
                name: "draft_email",
                description: "Draft a new email",
                inputSchema: zodToJsonSchema(SendEmailSchema),
            },
            {
                name: "read_email",
                description: "Retrieves the content of a specific email",
                inputSchema: zodToJsonSchema(ReadEmailSchema),
            },
            {
                name: "search_emails",
                description: "Searches for emails using Gmail search syntax",
                inputSchema: zodToJsonSchema(SearchEmailsSchema),
            },
            {
                name: "modify_email",
                description: "Modifies email labels (move to different folders)",
                inputSchema: zodToJsonSchema(ModifyEmailSchema),
            },
            {
                name: "delete_email",
                description: "Permanently deletes an email",
                inputSchema: zodToJsonSchema(DeleteEmailSchema),
            },
            {
                name: "list_email_labels",
                description: "Retrieves all available Gmail labels",
                inputSchema: zodToJsonSchema(ListEmailLabelsSchema),
            },
            {
                name: "batch_modify_emails",
                description: "Modifies labels for multiple emails in batches",
                inputSchema: zodToJsonSchema(BatchModifyEmailsSchema),
            },
            {
                name: "batch_delete_emails",
                description: "Permanently deletes multiple emails in batches",
                inputSchema: zodToJsonSchema(BatchDeleteEmailsSchema),
            },
            {
                name: "create_label",
                description: "Creates a new Gmail label",
                inputSchema: zodToJsonSchema(CreateLabelSchema),
            },
            {
                name: "update_label",
                description: "Updates an existing Gmail label",
                inputSchema: zodToJsonSchema(UpdateLabelSchema),
            },
            {
                name: "delete_label",
                description: "Deletes a Gmail label",
                inputSchema: zodToJsonSchema(DeleteLabelSchema),
            },
            {
                name: "get_or_create_label",
                description: "Gets an existing label by name or creates it if it doesn't exist",
                inputSchema: zodToJsonSchema(GetOrCreateLabelSchema),
            },
            {
                name: "create_filter",
                description: "Creates a new Gmail filter with custom criteria and actions",
                inputSchema: zodToJsonSchema(CreateFilterSchema),
            },
            {
                name: "list_filters",
                description: "Retrieves all Gmail filters",
                inputSchema: zodToJsonSchema(ListFiltersSchema),
            },
            {
                name: "get_filter",
                description: "Gets details of a specific Gmail filter",
                inputSchema: zodToJsonSchema(GetFilterSchema),
            },
            {
                name: "delete_filter",
                description: "Deletes a Gmail filter",
                inputSchema: zodToJsonSchema(DeleteFilterSchema),
            },
            {
                name: "create_filter_from_template",
                description: "Creates a filter using a pre-defined template for common scenarios",
                inputSchema: zodToJsonSchema(CreateFilterFromTemplateSchema),
            },
            {
                name: "download_attachment",
                description: "Downloads an email attachment to a specified location",
                inputSchema: zodToJsonSchema(DownloadAttachmentSchema),
            },
        ],
    }))

    // Import and use tool handlers from separate file
    const { handleToolCall } = await import('./tool-handlers.js');
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return await handleToolCall(request, gmail);
    });

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Send diagnostics after connect so FastMCP can display them
    await emitStartupDiagnostics();
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});