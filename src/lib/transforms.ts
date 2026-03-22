/**
 * Gemini Schema Compatibility Layer
 *
 * Transforms JSON Schemas into Gemini-compatible format.
 * Ported from fs-mcp's gemini_compat.py (LOG-001 through LOG-006).
 *
 * Why: Gemini implements a strict OpenAPI 3.0 subset of JSON Schema.
 * Common patterns like $ref, $defs, anyOf[T, null], title, default
 * either silently degrade (e.g., $ref → STRING) or cause API errors.
 *
 * This module transforms schemas unconditionally — the "lowest common
 * denominator" approach means if it works with Gemini, it works everywhere.
 *
 * Reference:
 * - LOG-001: Root cause ($ref not resolved, degrades to STRING)
 * - LOG-002: 22 transformation patterns for Gemini compatibility
 * - LOG-003: Implementation plan
 * - LOG-006: Production verification
 */

// Keys that must be removed from schemas
const FORBIDDEN_KEYS = new Set([
  // Not in Gemini Schema spec
  '$id',
  '$schema',
  'additionalProperties',
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
  // Documented but problematic (LOG-002 Section 5)
  'title',
  'default',
  'propertyOrdering',
  'property_ordering', // snake_case variant
])

// Keys to remove AFTER dereferencing
const DEFS_KEYS = new Set(['$defs', 'definitions'])

// Keys for conditional schemas (not supported by Gemini)
const CONDITIONAL_KEYS = new Set(['if', 'then', 'else'])

/**
 * Transform a JSON Schema to be Gemini-compatible.
 *
 * Transformations applied (in order):
 * 1. Dereference all $ref (inline definitions)
 * 2. Remove $defs, $id, $schema
 * 3. Convert anyOf[T, null] → {type: T, nullable: true}
 * 4. Convert const → enum
 * 5. Convert exclusiveMinimum/Maximum → minimum/maximum
 * 6. Remove forbidden keys: title, default, additionalProperties, etc.
 * 7. Remove conditional schemas: if/then/else
 *
 * @param schema - Raw JSON Schema (not modified)
 * @returns Gemini-compatible schema (new object)
 */
export function makeGeminiCompatible(schema: Record<string, any>): Record<string, any> {
  if (!schema || typeof schema !== 'object') return schema

  let result = structuredClone(schema)

  // Phase 1: Dereference $ref (CRITICAL - must be first)
  result = dereferenceRefs(result)

  // Phase 2: Remove $defs/$definitions (after dereferencing)
  result = removeDefs(result)

  // Phase 3: Handle anyOf/oneOf/allOf
  result = handleUnionTypes(result)

  // Phase 4: Convert const to enum
  result = convertConstToEnum(result)

  // Phase 5: Handle exclusive bounds
  result = handleExclusiveBounds(result)

  // Phase 6: Remove forbidden keys
  result = removeForbiddenKeys(result)

  // Phase 7: Remove conditional schemas
  result = removeConditionalSchemas(result)

  return result
}

// ============== Phase 1: Dereference $ref ==============

/**
 * Inline all $ref references by resolving them against $defs/definitions.
 *
 * This is the CRITICAL transformation — without it, nested objects
 * degrade to STRING in Gemini (see LOG-001).
 *
 * Uses a seen-set to handle circular references safely.
 */
function dereferenceRefs(schema: Record<string, any>): Record<string, any> {
  if (!containsKey(schema, '$ref')) return schema

  // Collect all definitions
  const defs: Record<string, any> = {
    ...(schema.$defs || {}),
    ...(schema.definitions || {}),
  }

  function resolveRef(ref: string): Record<string, any> | null {
    // Handle "#/$defs/Name" and "#/definitions/Name" patterns
    const match = ref.match(/^#\/(\$defs|definitions)\/(.+)$/)
    if (!match) return null
    const name = match[2]
    return defs[name] ?? null
  }

  function processNode(node: any, seen: Set<string> = new Set()): any {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((v) => processNode(v, seen))

    // Handle $ref
    if ('$ref' in node && typeof node.$ref === 'string') {
      const refPath = node.$ref
      if (seen.has(refPath)) {
        // Circular reference — return empty object to avoid infinite loop
        return { type: 'object', description: '(circular reference)' }
      }
      const resolved = resolveRef(refPath)
      if (resolved) {
        seen.add(refPath)
        const result = processNode(structuredClone(resolved), seen)
        seen.delete(refPath)
        return result
      }
      // Can't resolve — remove the $ref and return what we have
      const { $ref, ...rest } = node
      return Object.keys(rest).length > 0 ? processNode(rest, seen) : { type: 'string' }
    }

    // Recurse into all properties
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'object' && value !== null) {
        result[key] = processNode(value, seen)
      } else {
        result[key] = value
      }
    }
    return result
  }

  return processNode(schema)
}

// ============== Phase 2: Remove $defs ==============

function removeDefs(schema: Record<string, any>): Record<string, any> {
  const result = { ...schema }
  for (const key of DEFS_KEYS) {
    delete result[key]
  }
  return result
}

// ============== Phase 3: Handle Union Types ==============

/**
 * Handle anyOf, oneOf, and allOf constructs.
 *
 * - anyOf with null: Convert to {type: T, nullable: true}
 * - oneOf: Convert to anyOf (Gemini only supports anyOf)
 * - allOf: Merge schemas
 */
function handleUnionTypes(schema: Record<string, any>): Record<string, any> {
  function processNode(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return node
    }

    const result: Record<string, any> = {}

    for (const [key, value] of Object.entries(node)) {
      if (key === 'anyOf' && Array.isArray(value)) {
        const nonNull = value.filter((v: any) => !isNullType(v))
        const hasNull = value.some((v: any) => isNullType(v))

        if (hasNull && nonNull.length === 1) {
          // Convert to nullable
          const inner = processNode(nonNull[0])
          Object.assign(result, inner)
          result.nullable = true
        } else if (value.length === 1) {
          // Single-item anyOf, just unwrap
          Object.assign(result, processNode(value[0]))
        } else {
          // Keep anyOf but process children
          result.anyOf = value.map((v: any) => processNode(v))
        }
      } else if (key === 'oneOf' && Array.isArray(value)) {
        // Convert oneOf to anyOf (Gemini only supports anyOf)
        result.anyOf = value.map((v: any) => processNode(v))
      } else if (key === 'allOf' && Array.isArray(value)) {
        // Merge all schemas in allOf
        let merged: Record<string, any> = {}
        for (const sub of value) {
          const processed = processNode(sub)
          merged = mergeSchemas(merged, processed)
        }
        Object.assign(result, merged)
      } else if (key === 'properties' && typeof value === 'object' && value !== null) {
        result.properties = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, processNode(v)]),
        )
      } else if (key === 'items' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result.items = processNode(value)
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = processNode(value)
      } else if (Array.isArray(value)) {
        result[key] = value.map((v: any) => (typeof v === 'object' && v !== null ? processNode(v) : v))
      } else {
        result[key] = value
      }
    }

    return result
  }

  return processNode(schema)
}

// ============== Phase 4: Convert const to enum ==============

function convertConstToEnum(schema: Record<string, any>): Record<string, any> {
  function processNode(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node

    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'const') {
        result.enum = [value]
      } else if (typeof value === 'object' && value !== null) {
        result[key] = Array.isArray(value)
          ? value.map((v: any) => (typeof v === 'object' && v !== null ? processNode(v) : v))
          : processNode(value)
      } else {
        result[key] = value
      }
    }
    return result
  }

  return processNode(schema)
}

// ============== Phase 5: Handle Exclusive Bounds ==============

function handleExclusiveBounds(schema: Record<string, any>): Record<string, any> {
  function processNode(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node

    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'exclusiveMinimum') {
        result.minimum = value
      } else if (key === 'exclusiveMaximum') {
        result.maximum = value
      } else if (typeof value === 'object' && value !== null) {
        result[key] = Array.isArray(value)
          ? value.map((v: any) => (typeof v === 'object' && v !== null ? processNode(v) : v))
          : processNode(value)
      } else {
        result[key] = value
      }
    }
    return result
  }

  return processNode(schema)
}

// ============== Phase 6: Remove Forbidden Keys ==============

function removeForbiddenKeys(schema: Record<string, any>): Record<string, any> {
  function processNode(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node

    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key)) continue

      if (typeof value === 'object' && value !== null) {
        result[key] = Array.isArray(value)
          ? value.map((v: any) => (typeof v === 'object' && v !== null ? processNode(v) : v))
          : processNode(value)
      } else {
        result[key] = value
      }
    }
    return result
  }

  return processNode(schema)
}

// ============== Phase 7: Remove Conditional Schemas ==============

function removeConditionalSchemas(schema: Record<string, any>): Record<string, any> {
  function processNode(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node

    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(node)) {
      if (CONDITIONAL_KEYS.has(key)) continue

      if (typeof value === 'object' && value !== null) {
        result[key] = Array.isArray(value)
          ? value.map((v: any) => (typeof v === 'object' && v !== null ? processNode(v) : v))
          : processNode(value)
      } else {
        result[key] = value
      }
    }
    return result
  }

  return processNode(schema)
}

// ============== Helper Functions ==============

function isNullType(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return false
  const t = schema.type
  return t === 'null' || t === 'NULL'
}

function containsKey(obj: any, key: string): boolean {
  if (!obj || typeof obj !== 'object') return false
  if (Array.isArray(obj)) return obj.some((v) => containsKey(v, key))
  if (key in obj) return true
  return Object.values(obj).some((v) => containsKey(v, key))
}

function mergeSchemas(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const result = structuredClone(base)

  for (const [key, value] of Object.entries(overlay)) {
    if (key === 'properties' && 'properties' in result) {
      result.properties = { ...result.properties, ...value }
    } else if (key === 'required' && 'required' in result) {
      result.required = [...new Set([...result.required, ...value])]
    } else {
      result[key] = value
    }
  }

  return result
}
