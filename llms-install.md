# Gmail AutoAuth MCP Installation Guide

This guide will help you install and configure the Gmail AutoAuth MCP server for managing Gmail operations through Claude Desktop with auto authentication support.

## Requirements

- Node.js and npm installed
- Access to create a Google Cloud Project
- Local directory for configuration storage
- Web browser for OAuth authentication

## Installation Steps

1. OAuth client options (end user friendly):
   - Zero-setup: defaults to https://api.todofor.ai/gmail-oauth.json (no files needed). Override via GMAIL_OAUTH_URL.
   - BYO keys: place gcp-oauth.keys.json locally (advanced).

2. Set up the configuration directory (optional when using env/url):
```bash
mkdir -p ~/.gmail-mcp
# If using BYO keys:
# mv gcp-oauth.keys.json ~/.gmail-mcp/
```

3. Run authentication:
```bash
# Standard browser flow (uses bundled client if provided)
npx @todoforai/server-gmail-autoauth-mcp auth
```

Notes:
- You can still pass a custom callback URL for the standard flow:
  npx @todoforai/server-gmail-autoauth-mcp auth https://todofor.ai/oauth2callback
- Or for local:
  npx @todoforai/server-gmail-autoauth-mcp auth http://localhost:3000/oauth2callback

## Troubleshooting

If you encounter any issues during installation:

1. OAuth Keys Issues:
   - Verify gcp-oauth.keys.json exists in correct location
   - Check file permissions
   - Ensure keys contain valid web or installed credentials

2. Authentication Errors:
   - Confirm Gmail API is enabled
   - For web applications, verify redirect URI configuration
   - Check port 3000 is available during authentication

3. Configuration Issues:
   - Verify ~/.gmail-mcp directory exists and has correct permissions
   - Check credentials.json was created after authentication
   - Ensure Claude Desktop configuration is properly formatted

## Security Notes

- Store OAuth credentials securely in ~/.gmail-mcp/
- Never commit credentials to version control
- Use proper file permissions for config directory
- Regularly review access in Google Account settings
- Credentials are only accessible by current user

## Usage Examples

After installation, you can perform various Gmail operations:

### Send Email
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"]
}
```

### Search Emails
```json
{
  "query": "from:sender@example.com after:2024/01/01",
  "maxResults": 10
}
```

### Manage Email
- Read emails by ID
- Move emails between labels
- Mark emails as read/unread
- Delete emails
- List emails in different folders

For more details or support, please check the GitHub repository or file an issue.