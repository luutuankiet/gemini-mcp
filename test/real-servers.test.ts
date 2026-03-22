/**
 * Real Server E2E Tests
 *
 * Tests the Gemini transform pipeline against actual MCP servers that are
 * known to produce Gemini-incompatible schemas. Uses dummy/no credentials —
 * tools/list is a pure in-memory operation in the MCP SDK, no real API calls.
 *
 * Test pattern:
 * 1. Connect directly to upstream server via stdio
 * 2. Get raw tool schemas (proves server works with dummy creds)
 * 3. Verify raw schemas ARE incompatible (baseline — our transforms are needed)
 * 4. Run makeGeminiCompatible() on each schema
 * 5. Verify transformed schemas have zero forbidden keys
 *
 * Servers tested:
 * - @notionhq/notion-mcp-server — allOf/anyOf/additionalProperties composition
 * - awslabs.aws-api-mcp-server — $ref/$defs from Pydantic (requires uvx)
 *
 * References:
 * - gemini-cli #13270: aws-api-mcp-server $defs failure
 * - gemini-cli #11020: notion additionalProperties composition bug
 * - gemini-cli #13326: Snowflake $ref inside anyOf
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { execSync } from 'child_process'

// Import from the built dist (test/ is a separate package — parent must be built first)
const { makeGeminiCompatible } = (await import('../dist/index.js')) as {
  makeGeminiCompatible: (schema: Record<string, any>) => Record<string, any>
}

// ============== Gemini Schema Validators ==============

/** Keys that must NEVER appear in a Gemini-compatible schema */
const GEMINI_FORBIDDEN = new Set([
  '$ref',
  '$defs',
  'definitions',
  '$id',
  '$schema',
  'additionalProperties',
  'title',
  'default',
  'not',
  'dependentRequired',
  'dependentSchemas',
  'prefixItems',
  'contains',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentMediaType',
  'contentEncoding',
  'multipleOf',
  'if',
  'then',
  'else',
  'oneOf', // should be converted to anyOf
  'allOf', // should be merged
  'const', // should be converted to enum
  'exclusiveMinimum',
  'exclusiveMaximum',
  'propertyOrdering',
  'property_ordering',
])

/**
 * Recursively find all Gemini-forbidden keys in a schema.
 * Returns an array of {path, key} violations.
 */
function findForbiddenKeys(schema: any, path = 'root'): Array<{ path: string; key: string }> {
  const violations: Array<{ path: string; key: string }> = []
  if (!schema || typeof schema !== 'object') return violations

  if (Array.isArray(schema)) {
    schema.forEach((item, i) => {
      violations.push(...findForbiddenKeys(item, `${path}[${i}]`))
    })
    return violations
  }

  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_FORBIDDEN.has(key)) {
      violations.push({ path, key })
    }
    if (typeof value === 'object' && value !== null) {
      violations.push(...findForbiddenKeys(value, `${path}.${key}`))
    }
  }
  return violations
}

/**
 * Assert a schema is fully Gemini-compatible (no forbidden keys anywhere).
 */
function assertGeminiCompatible(toolName: string, schema: any) {
  const violations = findForbiddenKeys(schema)
  if (violations.length > 0) {
    const details = violations
      .slice(0, 10)
      .map((v) => `  ${v.path} → "${v.key}"`)
      .join('\n')
    const more = violations.length > 10 ? `\n  ... and ${violations.length - 10} more` : ''
    throw new Error(`Tool "${toolName}" has ${violations.length} Gemini-incompatible key(s):\n${details}${more}`)
  }
}

// ============== Test Helpers ==============

interface ServerConnection {
  client: Client
  cleanup: () => Promise<void>
}

/**
 * Connect directly to a local stdio MCP server.
 */
async function connectToServer(command: string, args: string[], env: Record<string, string> = {}): Promise<ServerConnection> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  })

  const client = new Client({ name: 'gemini-mcp-real-server-test', version: '1.0.0' }, { capabilities: {} })

  await client.connect(transport)
  return {
    client,
    cleanup: async () => {
      try {
        await client.close()
      } catch {
        // ignore cleanup errors
      }
    },
  }
}

async function getTools(client: Client) {
  const response = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
  return response.tools || []
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// ============== Tests ==============

describe('Real Server: @notionhq/notion-mcp-server', () => {
  let conn: ServerConnection | null = null

  afterEach(async () => {
    if (conn) {
      await conn.cleanup()
      conn = null
    }
  })

  it('raw schemas are Gemini-incompatible, transforms fix them', async () => {
    // Connect with no token — tools/list works without auth
    conn = await connectToServer('npx', ['-y', '@notionhq/notion-mcp-server'])
    const tools = await getTools(conn.client)

    expect(tools.length).toBeGreaterThan(0)
    console.log(`  📡 Notion: ${tools.length} tools discovered`)

    // BASELINE: Count incompatible keys in raw schemas
    let rawViolations = 0
    const brokenTools: string[] = []
    for (const tool of tools) {
      const violations = findForbiddenKeys(tool.inputSchema)
      rawViolations += violations.length
      if (violations.length > 0) {
        brokenTools.push(`${tool.name}(${violations.length})`)
      }
    }

    console.log(`  ⚠️  Baseline: ${rawViolations} incompatible keys in ${brokenTools.length}/${tools.length} tools`)
    if (brokenTools.length > 0) {
      console.log(`     Broken: ${brokenTools.slice(0, 5).join(', ')}${brokenTools.length > 5 ? ` +${brokenTools.length - 5} more` : ''}`)
    }

    // Raw schemas should have incompatibilities (otherwise why proxy?)
    expect(rawViolations).toBeGreaterThan(0)

    // TRANSFORM: Run makeGeminiCompatible on each schema
    let transformedViolations = 0
    for (const tool of tools) {
      const transformed = makeGeminiCompatible(tool.inputSchema as Record<string, any>)
      assertGeminiCompatible(tool.name, transformed)
    }

    console.log(`  ✅ All ${tools.length} Notion tool schemas are Gemini-compatible after transform`)
  }, 120_000)
})

describe('Real Server: awslabs.aws-api-mcp-server', () => {
  let conn: ServerConnection | null = null
  const hasUvx = isCommandAvailable('uvx')

  afterEach(async () => {
    if (conn) {
      await conn.cleanup()
      conn = null
    }
  })

  it.skipIf(!hasUvx)(
    'raw schemas are Gemini-incompatible, transforms fix them',
    async () => {
      // AWS_REGION is required to start the server, but no credentials needed for tools/list
      conn = await connectToServer('uvx', ['awslabs.aws-api-mcp-server@latest'], { AWS_REGION: 'us-east-1' })
      const tools = await getTools(conn.client)

      expect(tools.length).toBeGreaterThan(0)
      console.log(`  📡 AWS API: ${tools.length} tools discovered`)

      // BASELINE: Verify raw schemas have $ref/$defs (the known Gemini killer)
      let rawViolations = 0
      let hasRefDefs = false
      const brokenTools: string[] = []
      for (const tool of tools) {
        const violations = findForbiddenKeys(tool.inputSchema)
        rawViolations += violations.length
        if (violations.some((v) => v.key === '$ref' || v.key === '$defs')) {
          hasRefDefs = true
        }
        if (violations.length > 0) {
          brokenTools.push(`${tool.name}(${violations.length})`)
        }
      }

      console.log(`  ⚠️  Baseline: ${rawViolations} incompatible keys (has $ref/$defs: ${hasRefDefs})`)
      if (brokenTools.length > 0) {
        console.log(`     Broken: ${brokenTools.slice(0, 5).join(', ')}${brokenTools.length > 5 ? ` +${brokenTools.length - 5} more` : ''}`)
      }

      expect(rawViolations).toBeGreaterThan(0)

      // TRANSFORM: Every schema must be clean after transform
      for (const tool of tools) {
        const transformed = makeGeminiCompatible(tool.inputSchema as Record<string, any>)
        assertGeminiCompatible(tool.name, transformed)
      }

      console.log(`  ✅ All ${tools.length} AWS API tool schemas are Gemini-compatible after transform`)
    },
    180_000,
  )
})

// ============== Stdio Proxy Wrapping Tests ==============
// These test the full pipeline: client → proxy (stdio mode) → upstream server

import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROXY_PATH = resolve(__dirname, '../dist/proxy.js')

describe('Stdio Proxy: client → gemini-mcp → upstream server', () => {
  let conn: ServerConnection | null = null

  afterEach(async () => {
    if (conn) {
      await conn.cleanup()
      conn = null
    }
  })

  it('Notion schemas are Gemini-compatible through stdio proxy', async () => {
    // Client connects to our proxy, which spawns Notion as a child process
    conn = await connectToServer('node', [PROXY_PATH, 'npx', '-y', '@notionhq/notion-mcp-server'])
    const tools = await getTools(conn.client)

    expect(tools.length).toBeGreaterThan(0)
    console.log(`  📡 Notion via proxy: ${tools.length} tools discovered`)

    // All schemas should already be transformed — no violations
    for (const tool of tools) {
      assertGeminiCompatible(tool.name, tool.inputSchema)
    }

    console.log(`  ✅ All ${tools.length} Notion schemas are Gemini-compatible through stdio proxy`)
  }, 120_000)

  it.skipIf(!isCommandAvailable('uvx'))(
    'AWS API schemas are Gemini-compatible through stdio proxy',
    async () => {
      conn = await connectToServer('node', [PROXY_PATH, 'uvx', 'awslabs.aws-api-mcp-server@latest'], {
        AWS_REGION: 'us-east-1',
      })
      const tools = await getTools(conn.client)

      expect(tools.length).toBeGreaterThan(0)
      console.log(`  📡 AWS API via proxy: ${tools.length} tools discovered`)

      for (const tool of tools) {
        assertGeminiCompatible(tool.name, tool.inputSchema)
      }

      console.log(`  ✅ All ${tools.length} AWS API schemas are Gemini-compatible through stdio proxy`)
    },
    180_000,
  )
})
