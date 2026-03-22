/**
 * E2E Tests: Proxy with Gemini Schema Transforms
 *
 * Tests the full proxy pipeline: client → proxy → server → proxy → client
 * using InMemoryTransport (no real stdio/network needed).
 *
 * Verifies:
 * 1. tools/list responses have schemas transformed for Gemini
 * 2. tools/call requests pass through unchanged
 * 3. tools/call responses pass through unchanged
 * 4. Non-tool messages pass through unchanged
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mcpProxy } from './utils'

/**
 * Helper: Send a JSON-RPC request through a transport and wait for a response.
 */
function sendAndReceive(
  sendTransport: InMemoryTransport,
  receiveTransport: InMemoryTransport,
  request: Record<string, any>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for response')), 5000)

    receiveTransport.onmessage = (message: any) => {
      clearTimeout(timeout)
      resolve(message)
    }

    sendTransport.send(request as any).catch(reject)
  })
}

describe('E2E: Proxy with Gemini Schema Transforms', () => {
  let clientToProxy: InMemoryTransport
  let proxyToClient: InMemoryTransport
  let proxyToServer: InMemoryTransport
  let serverToProxy: InMemoryTransport

  beforeEach(async () => {
    // Create two linked pairs:
    // Client ↔ Proxy (client side)
    ;[clientToProxy, proxyToClient] = InMemoryTransport.createLinkedPair()
    // Proxy (server side) ↔ Server
    ;[proxyToServer, serverToProxy] = InMemoryTransport.createLinkedPair()

    // Start all transports
    await clientToProxy.start()
    await proxyToClient.start()
    await proxyToServer.start()
    await serverToProxy.start()

    // Wire up the proxy
    mcpProxy({
      transportToClient: proxyToClient,
      transportToServer: proxyToServer,
    })
  })

  it('should transform $ref in tools/list response', async () => {
    // Simulate: client sends tools/list, server responds with $ref schema
    const toolsListRequest = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/list',
      params: {},
    }

    // Set up server to respond
    const responsePromise = new Promise<any>((resolve) => {
      clientToProxy.onmessage = (msg: any) => resolve(msg)
    })

    // Server will receive the request and send back a response with $ref
    serverToProxy.onmessage = async (msg: any) => {
      if (msg.method === 'tools/list') {
        await serverToProxy.send({
          jsonrpc: '2.0' as const,
          id: msg.id,
          result: {
            tools: [
              {
                name: 'read_files',
                description: 'Read files',
                inputSchema: {
                  type: 'object',
                  properties: {
                    files: {
                      type: 'array',
                      items: { $ref: '#/$defs/FileReadRequest' },
                    },
                  },
                  required: ['files'],
                  $defs: {
                    FileReadRequest: {
                      type: 'object',
                      title: 'FileReadRequest',
                      properties: {
                        path: { type: 'string', description: 'File path' },
                        start_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                      },
                      required: ['path'],
                    },
                  },
                },
              },
            ],
          },
        } as any)
      }
    }

    // Send the request from client
    await clientToProxy.send(toolsListRequest as any)
    const response = await responsePromise

    // Verify the schema was transformed
    const tool = response.result.tools[0]
    const schema = tool.inputSchema

    // $ref should be inlined
    expect(JSON.stringify(schema)).not.toContain('$ref')
    expect(schema.$defs).toBeUndefined()

    // FileReadRequest should be a full object
    const items = schema.properties.files.items
    expect(items.type).toBe('object')
    expect(items.properties.path.type).toBe('string')

    // anyOf[integer, null] → nullable integer
    expect(items.properties.start_line.type).toBe('integer')
    expect(items.properties.start_line.nullable).toBe(true)

    // title should be removed
    expect(JSON.stringify(schema)).not.toContain('"title"')
  })

  it('should pass tools/call request through unchanged', async () => {
    const toolCallRequest = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: {
        name: 'read_files',
        arguments: {
          files: [{ path: 'test.md', start_line: 1 }],
        },
      },
    }

    // Capture what the server receives
    const serverReceived = new Promise<any>((resolve) => {
      serverToProxy.onmessage = (msg: any) => resolve(msg)
    })

    await clientToProxy.send(toolCallRequest as any)
    const received = await serverReceived

    // Request should pass through unchanged
    expect(received.method).toBe('tools/call')
    expect(received.params.name).toBe('read_files')
    expect(received.params.arguments.files[0].path).toBe('test.md')
    expect(received.params.arguments.files[0].start_line).toBe(1)
  })

  it('should pass tools/call response through unchanged', async () => {
    // First send a request so the message transformer can correlate the response
    const toolCallRequest = {
      jsonrpc: '2.0' as const,
      id: 3,
      method: 'tools/call',
      params: {
        name: 'read_files',
        arguments: { files: [{ path: 'test.md' }] },
      },
    }

    const clientReceived = new Promise<any>((resolve) => {
      clientToProxy.onmessage = (msg: any) => resolve(msg)
    })

    serverToProxy.onmessage = async (msg: any) => {
      // Server responds with file content
      await serverToProxy.send({
        jsonrpc: '2.0' as const,
        id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Hello, World!' }],
        },
      } as any)
    }

    await clientToProxy.send(toolCallRequest as any)
    const response = await clientReceived

    // Response should pass through unchanged
    expect(response.result.content[0].text).toBe('Hello, World!')
  })

  it('should pass initialize through (with modified clientInfo)', async () => {
    const initRequest = {
      jsonrpc: '2.0' as const,
      id: 4,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'TestClient', version: '1.0' },
      },
    }

    const serverReceived = new Promise<any>((resolve) => {
      serverToProxy.onmessage = (msg: any) => resolve(msg)
    })

    await clientToProxy.send(initRequest as any)
    const received = await serverReceived

    // Should have modified clientInfo name to include gemini-mcp
    expect(received.params.clientInfo.name).toContain('gemini-mcp')
    // But otherwise pass through
    expect(received.method).toBe('initialize')
    expect(received.params.protocolVersion).toBe('2024-11-05')
  })

  it('should handle tools/list with multiple tools, some clean some dirty', async () => {
    const toolsListRequest = {
      jsonrpc: '2.0' as const,
      id: 5,
      method: 'tools/list',
      params: {},
    }

    const responsePromise = new Promise<any>((resolve) => {
      clientToProxy.onmessage = (msg: any) => resolve(msg)
    })

    serverToProxy.onmessage = async (msg: any) => {
      await serverToProxy.send({
        jsonrpc: '2.0' as const,
        id: msg.id,
        result: {
          tools: [
            {
              name: 'clean_tool',
              description: 'Already Gemini-compatible',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query' },
                },
                required: ['query'],
              },
            },
            {
              name: 'dirty_tool',
              description: 'Has $ref and forbidden keys',
              inputSchema: {
                type: 'object',
                title: 'DirtySchema',
                additionalProperties: false,
                properties: {
                  items: {
                    type: 'array',
                    items: { $ref: '#/$defs/Item' },
                  },
                  count: { type: 'integer', default: 10 },
                },
                $defs: {
                  Item: {
                    type: 'object',
                    title: 'Item',
                    properties: {
                      id: { type: 'string' },
                      value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                    },
                    required: ['id'],
                  },
                },
              },
            },
          ],
        },
      } as any)
    }

    await clientToProxy.send(toolsListRequest as any)
    const response = await responsePromise

    // Clean tool should be mostly unchanged (type/description/required preserved)
    const cleanTool = response.result.tools.find((t: any) => t.name === 'clean_tool')
    expect(cleanTool.inputSchema.properties.query.type).toBe('string')
    expect(cleanTool.inputSchema.required).toEqual(['query'])

    // Dirty tool should be fully transformed
    const dirtyTool = response.result.tools.find((t: any) => t.name === 'dirty_tool')
    const dirtySchema = dirtyTool.inputSchema

    // $ref inlined, $defs removed
    expect(JSON.stringify(dirtySchema)).not.toContain('$ref')
    expect(dirtySchema.$defs).toBeUndefined()

    // Items should be objects, not strings
    expect(dirtySchema.properties.items.items.type).toBe('object')
    expect(dirtySchema.properties.items.items.properties.id.type).toBe('string')

    // nullable conversion
    expect(dirtySchema.properties.items.items.properties.value.type).toBe('number')
    expect(dirtySchema.properties.items.items.properties.value.nullable).toBe(true)

    // forbidden keys removed
    expect(JSON.stringify(dirtySchema)).not.toContain('"title"')
    expect(JSON.stringify(dirtySchema)).not.toContain('"default"')
    expect(dirtySchema.additionalProperties).toBeUndefined()
  })
})
