#!/usr/bin/env node

/**
 * MCP Proxy with Gemini schema transforms
 *
 * Two modes:
 *   Remote: npx gemini-mcp https://example.remote/server [callback-port]
 *   Stdio:  npx gemini-mcp <command> [args...]
 *
 * In remote mode, proxies between local stdio and a remote SSE/HTTP server with OAuth.
 * In stdio mode, spawns a local MCP server as a child process and proxies stdio↔stdio.
 * Both modes intercept tools/list and transform schemas for Gemini compatibility.
 */

import { EventEmitter } from 'events'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  connectToRemoteServer,
  log,
  debugLog,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportStrategy,
  discoverOAuthServerInfo,
} from './lib/utils'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { createLazyAuthCoordinator } from './lib/coordination'

/**
 * Main function to run the proxy
 */
async function runProxy(
  serverUrl: string,
  callbackPort: number,
  headers: Record<string, string>,
  transportStrategy: TransportStrategy = 'http-first',
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
  ignoredTools: string[],
  authTimeoutMs: number,
  serverUrlHash: string,
) {
  // Set up event emitter for auth flow
  const events = new EventEmitter()

  // Create a lazy auth coordinator
  const authCoordinator = createLazyAuthCoordinator(serverUrlHash, callbackPort, events, authTimeoutMs)

  // Discover OAuth server info via Protected Resource Metadata (RFC 9728)
  // This probes the MCP server for WWW-Authenticate header and fetches PRM
  log('Discovering OAuth server configuration...')
  const discoveryResult = await discoverOAuthServerInfo(serverUrl, headers)

  if (discoveryResult.protectedResourceMetadata) {
    log(`Discovered authorization server: ${discoveryResult.authorizationServerUrl}`)
    if (discoveryResult.protectedResourceMetadata.scopes_supported) {
      debugLog('Protected Resource Metadata scopes', {
        scopes_supported: discoveryResult.protectedResourceMetadata.scopes_supported,
      })
    }
  } else {
    debugLog('No Protected Resource Metadata found, using server URL as authorization server')
  }

  // Create the OAuth client provider with discovered server info
  const authProvider = new NodeOAuthClientProvider({
    serverUrl: discoveryResult.authorizationServerUrl,
    callbackPort,
    host,
    clientName: 'MCP CLI Proxy',
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    serverUrlHash,
    authorizationServerMetadata: discoveryResult.authorizationServerMetadata,
    protectedResourceMetadata: discoveryResult.protectedResourceMetadata,
    wwwAuthenticateScope: discoveryResult.wwwAuthenticateScope,
  })

  // Create the STDIO transport for local connections
  const localTransport = new StdioServerTransport()

  // Keep track of the server instance for cleanup
  let server: any = null

  // Define an auth initializer function
  const authInitializer = async () => {
    const authState = await authCoordinator.initializeAuth()

    // Store server in outer scope for cleanup
    server = authState.server

    // If auth was completed by another instance, just log that we'll use the auth from disk
    if (authState.skipBrowserAuth) {
      log('Authentication was completed by another instance - will use tokens from disk')
      // TODO: remove, the callback is happening before the tokens are exchanged
      //  so we're slightly too early
      await new Promise((res) => setTimeout(res, 1_000))
    }

    return {
      waitForAuthCode: authState.waitForAuthCode,
      skipBrowserAuth: authState.skipBrowserAuth,
    }
  }

  try {
    // Connect to remote server with lazy authentication
    const remoteTransport = await connectToRemoteServer(null, serverUrl, authProvider, headers, authInitializer, transportStrategy)

    // Set up bidirectional proxy between local and remote transports
    mcpProxy({
      transportToClient: localTransport,
      transportToServer: remoteTransport,
      ignoredTools,
    })

    // Start the local STDIO server
    await localTransport.start()
    log('Local STDIO server running')
    log(`Proxy established successfully between local STDIO and remote ${remoteTransport.constructor.name}`)
    log('Press Ctrl+C to exit')

    // Setup cleanup handler
    const cleanup = async () => {
      await remoteTransport.close()
      await localTransport.close()
      // Only close the server if it was initialized
      if (server) {
        server.close()
      }
    }
    setupSignalHandlers(cleanup)
  } catch (error) {
    log('Fatal error:', error)
    if (error instanceof Error && error.message.includes('self-signed certificate in certificate chain')) {
      log(`You may be behind a VPN!

If you are behind a VPN, you can try setting the NODE_EXTRA_CA_CERTS environment variable to point
to the CA certificate file. If using claude_desktop_config.json, this might look like:

{
  "mcpServers": {
    "\${mcpServerName}": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "\${your CA certificate file path}.pem"
      }
    }
  }
}
        `)
    }
    // Only close the server if it was initialized
    if (server) {
      server.close()
    }
    process.exit(1)
  }
}

/**
 * Stdio-to-stdio proxy mode.
 * Spawns a local MCP server as a child process and proxies between
 * the client's stdio and the child's stdio, with Gemini transforms applied.
 */
async function runStdioProxy(command: string, commandArgs: string[], ignoredTools: string[]) {
  // Client-facing side: we ARE the MCP server to the caller
  const localTransport = new StdioServerTransport()

  // Upstream side: spawn the real MCP server as a child process
  const remoteTransport = new StdioClientTransport({
    command,
    args: commandArgs,
    env: process.env as Record<string, string>,
  })

  // Wire them together — Gemini transforms happen inside mcpProxy on tools/list
  mcpProxy({
    transportToClient: localTransport,
    transportToServer: remoteTransport,
    ignoredTools,
  })

  // Start both transports
  await remoteTransport.start()
  await localTransport.start()

  log(`Stdio proxy running: ${command} ${commandArgs.join(' ')}`)
  log('Gemini schema transforms active on tools/list responses')

  // Cleanup on exit
  const cleanup = async () => {
    await remoteTransport.close()
    await localTransport.close()
  }
  setupSignalHandlers(cleanup)
}

/**
 * Detect whether the first arg is a URL or a command.
 * If it parses as a URL with http(s) protocol, it's remote mode.
 * Otherwise, it's a command to spawn in stdio mode.
 */
function isUrl(arg: string): boolean {
  try {
    const url = new URL(arg)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

// Parse command-line arguments and run the appropriate mode
const args = process.argv.slice(2)

if (args.length === 0) {
  log('Usage:')
  log('  Remote: npx gemini-mcp <https://server-url> [callback-port] [--debug]')
  log('  Stdio:  npx gemini-mcp <command> [args...] [--debug]')
  process.exit(1)
}

if (isUrl(args[0])) {
  // Remote mode — parse all flags and connect to remote server
  parseCommandLineArgs(args, 'Usage: npx gemini-mcp <https://server-url> [callback-port] [--debug]')
    .then(
      ({
        serverUrl,
        callbackPort,
        headers,
        transportStrategy,
        host,
        debug,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        authorizeResource,
        ignoredTools,
        authTimeoutMs,
        serverUrlHash,
      }) => {
        return runProxy(
          serverUrl,
          callbackPort,
          headers,
          transportStrategy,
          host,
          staticOAuthClientMetadata,
          staticOAuthClientInfo,
          authorizeResource,
          ignoredTools,
          authTimeoutMs,
          serverUrlHash,
        )
      },
    )
    .catch((error) => {
      log('Fatal error:', error)
      process.exit(1)
    })
} else {
  // Stdio mode — first arg is a command, rest are its arguments
  // Extract gemini-mcp-specific flags before passing remaining args to the child
  const command = args[0]
  const childArgs: string[] = []
  const ignoredTools: string[] = []

  let i = 1
  while (i < args.length) {
    if (args[i] === '--ignore-tool' && i < args.length - 1) {
      ignoredTools.push(args[i + 1])
      log(`Ignoring tool: ${args[i + 1]}`)
      i += 2
      continue
    }
    if (args[i] === '--debug') {
      // Enable debug mode but don't pass to child
      i++
      continue
    }
    // Everything else is passed to the child command
    childArgs.push(args[i])
    i++
  }

  runStdioProxy(command, childArgs, ignoredTools).catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
}
