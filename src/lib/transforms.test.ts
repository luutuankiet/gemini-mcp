/**
 * Tests for Gemini Schema Compatibility Transforms
 *
 * Ported from fs-mcp's test_gemini_schema_compat.py
 * Covers all 7 transformation phases and regression tests from LOG-001.
 */

import { describe, it, expect } from 'vitest'
import { makeGeminiCompatible } from './transforms'

// ============================================================================
// Phase 1: $ref Dereferencing (CRITICAL — LOG-001 root cause)
// ============================================================================

describe('Phase 1: $ref Dereferencing', () => {
  it('should inline $ref to $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        item: { $ref: '#/$defs/Item' },
      },
      $defs: {
        Item: { type: 'string', description: 'An item' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.item.type).toBe('string')
    expect(result.properties.item.description).toBe('An item')
    expect(JSON.stringify(result)).not.toContain('$ref')
    expect(result.$defs).toBeUndefined()
  })

  it('should inline $ref to definitions (legacy key)', () => {
    const schema = {
      type: 'object',
      properties: {
        item: { $ref: '#/definitions/Item' },
      },
      definitions: {
        Item: { type: 'integer', description: 'A number' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.item.type).toBe('integer')
    expect(JSON.stringify(result)).not.toContain('$ref')
    expect(result.definitions).toBeUndefined()
  })

  it('should inline nested $ref (object with properties)', () => {
    const schema = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { $ref: '#/$defs/FileReadRequest' },
        },
      },
      $defs: {
        FileReadRequest: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            start_line: { type: 'integer' },
            end_line: { type: 'integer' },
          },
          required: ['path'],
        },
      },
    }

    const result = makeGeminiCompatible(schema)

    // The exact LOG-001 fix: items must be an object, NOT a string
    const items = result.properties.files.items
    expect(items.type).toBe('object')
    expect(items.properties).toBeDefined()
    expect(items.properties.path.type).toBe('string')
    expect(items.properties.start_line.type).toBe('integer')
    expect(items.required).toEqual(['path'])
    expect(JSON.stringify(result)).not.toContain('$ref')
  })

  it('should handle circular references safely', () => {
    const schema = {
      type: 'object',
      properties: {
        child: { $ref: '#/$defs/Node' },
      },
      $defs: {
        Node: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            child: { $ref: '#/$defs/Node' }, // circular!
          },
        },
      },
    }

    // Should not throw or infinite loop
    const result = makeGeminiCompatible(schema)

    expect(result.properties.child.type).toBe('object')
    expect(result.properties.child.properties.name.type).toBe('string')
    // Circular ref should be handled (not crash)
    expect(JSON.stringify(result)).not.toContain('$ref')
  })

  it('should pass through schema without $ref unchanged', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.name.type).toBe('string')
    expect(result.properties.age.type).toBe('integer')
  })
})

// ============================================================================
// Phase 2: $defs Removal
// ============================================================================

describe('Phase 2: $defs Removal', () => {
  it('should remove $defs after dereferencing', () => {
    const schema = {
      type: 'object',
      $defs: { Foo: { type: 'string' } },
      properties: { x: { $ref: '#/$defs/Foo' } },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.$defs).toBeUndefined()
    expect(result.definitions).toBeUndefined()
  })
})

// ============================================================================
// Phase 3: Union Types (anyOf/oneOf/allOf)
// ============================================================================

describe('Phase 3: Union Types', () => {
  it('should convert anyOf[T, null] to nullable', () => {
    const schema = {
      type: 'object',
      properties: {
        start_line: {
          anyOf: [{ type: 'integer' }, { type: 'null' }],
        },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.start_line.type).toBe('integer')
    expect(result.properties.start_line.nullable).toBe(true)
    expect(result.properties.start_line.anyOf).toBeUndefined()
  })

  it('should convert anyOf[{type: string, desc}, null] preserving description', () => {
    const schema = {
      type: 'object',
      properties: {
        pattern: {
          anyOf: [{ type: 'string', description: 'A regex pattern' }, { type: 'null' }],
        },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.pattern.type).toBe('string')
    expect(result.properties.pattern.description).toBe('A regex pattern')
    expect(result.properties.pattern.nullable).toBe(true)
  })

  it('should unwrap single-item anyOf', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { anyOf: [{ type: 'string' }] },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.x.type).toBe('string')
    expect(result.properties.x.anyOf).toBeUndefined()
  })

  it('should keep multi-type anyOf (no null)', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.x.anyOf).toHaveLength(2)
  })

  it('should convert oneOf to anyOf', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.x.anyOf).toHaveLength(2)
    expect(result.properties.x.oneOf).toBeUndefined()
  })

  it('should merge allOf schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        x: {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { properties: { b: { type: 'integer' } }, required: ['b'] },
          ],
        },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.x.properties.a.type).toBe('string')
    expect(result.properties.x.properties.b.type).toBe('integer')
    expect(result.properties.x.required).toEqual(expect.arrayContaining(['a', 'b']))
    expect(result.properties.x.allOf).toBeUndefined()
  })
})

// ============================================================================
// Phase 4: const → enum
// ============================================================================

describe('Phase 4: const to enum', () => {
  it('should convert const to single-value enum', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { const: 'read' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.mode.enum).toEqual(['read'])
    expect(result.properties.mode.const).toBeUndefined()
  })
})

// ============================================================================
// Phase 5: Exclusive Bounds
// ============================================================================

describe('Phase 5: Exclusive Bounds', () => {
  it('should convert exclusiveMinimum to minimum', () => {
    const schema = {
      type: 'object',
      properties: {
        age: { type: 'integer', exclusiveMinimum: 0 },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.age.minimum).toBe(0)
    expect(result.properties.age.exclusiveMinimum).toBeUndefined()
  })

  it('should convert exclusiveMaximum to maximum', () => {
    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number', exclusiveMaximum: 100 },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.properties.score.maximum).toBe(100)
    expect(result.properties.score.exclusiveMaximum).toBeUndefined()
  })
})

// ============================================================================
// Phase 6: Forbidden Keys
// ============================================================================

describe('Phase 6: Forbidden Keys', () => {
  it('should remove title at all levels', () => {
    const schema = {
      type: 'object',
      title: 'MySchema',
      properties: {
        name: { type: 'string', title: 'Name Field' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(JSON.stringify(result)).not.toContain('title')
  })

  it('should remove default at all levels', () => {
    const schema = {
      type: 'object',
      properties: {
        compact: { type: 'boolean', default: true },
        name: { type: 'string', default: 'foo' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(JSON.stringify(result)).not.toContain('default')
  })

  it('should remove additionalProperties', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.additionalProperties).toBeUndefined()
  })

  it('should remove $id and $schema', () => {
    const schema = {
      $id: 'https://example.com/schema',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.$id).toBeUndefined()
    expect(result.$schema).toBeUndefined()
  })

  it('should remove propertyOrdering', () => {
    const schema = {
      type: 'object',
      propertyOrdering: ['name', 'age'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.propertyOrdering).toBeUndefined()
  })
})

// ============================================================================
// Phase 7: Conditional Schemas
// ============================================================================

describe('Phase 7: Conditional Schemas', () => {
  it('should remove if/then/else', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { type: 'string' },
      },
      if: { properties: { mode: { const: 'advanced' } } },
      then: { required: ['extra'] },
      else: { required: [] },
    }

    const result = makeGeminiCompatible(schema)

    expect(result.if).toBeUndefined()
    expect(result.then).toBeUndefined()
    expect(result.else).toBeUndefined()
  })
})

// ============================================================================
// Regression Tests (LOG-001 specific failure modes)
// ============================================================================

describe('Regression: LOG-001 FileReadRequest', () => {
  it('should preserve full FileReadRequest structure (not degrade to STRING)', () => {
    // This is the EXACT schema that broke Gemini in LOG-001
    const schema = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'A list of file read requests',
          items: { $ref: '#/$defs/FileReadRequest' },
        },
        large_file_passthrough: {
          type: 'boolean',
          description: 'Allow large files',
        },
      },
      required: ['files'],
      $defs: {
        FileReadRequest: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The path to the file' },
            start_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            end_line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            head: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            tail: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            read_to_next_pattern: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['path'],
        },
      },
    }

    const result = makeGeminiCompatible(schema)

    // CRITICAL: items must be an object with properties, NOT a string
    const items = result.properties.files.items
    expect(items.type).toBe('object')
    expect(items.properties).toBeDefined()
    expect(items.properties.path.type).toBe('string')

    // Optional fields should be nullable, not anyOf
    expect(items.properties.start_line.type).toBe('integer')
    expect(items.properties.start_line.nullable).toBe(true)
    expect(items.properties.start_line.anyOf).toBeUndefined()

    expect(items.properties.read_to_next_pattern.type).toBe('string')
    expect(items.properties.read_to_next_pattern.nullable).toBe(true)

    // No forbidden patterns remain
    expect(JSON.stringify(result)).not.toContain('$ref')
    expect(JSON.stringify(result)).not.toContain('$defs')

    // Top-level structure preserved
    expect(result.required).toEqual(['files'])
    expect(result.properties.large_file_passthrough.type).toBe('boolean')
  })
})

describe('Regression: EditPair nested model', () => {
  it('should preserve EditPair structure in propose_and_review schema', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          anyOf: [
            {
              type: 'array',
              items: { $ref: '#/$defs/EditPair' },
            },
            { type: 'null' },
          ],
        },
      },
      $defs: {
        EditPair: {
          type: 'object',
          properties: {
            match_text: { type: 'string', title: 'Match Text' },
            new_string: { type: 'string', title: 'New String' },
          },
          required: ['match_text', 'new_string'],
          title: 'EditPair',
        },
      },
    }

    const result = makeGeminiCompatible(schema)

    // edits should be nullable array (not anyOf)
    expect(result.properties.edits.type).toBe('array')
    expect(result.properties.edits.nullable).toBe(true)

    // EditPair should be inlined
    const editItems = result.properties.edits.items
    expect(editItems.type).toBe('object')
    expect(editItems.properties.match_text.type).toBe('string')
    expect(editItems.properties.new_string.type).toBe('string')
    expect(editItems.required).toEqual(['match_text', 'new_string'])

    // title should be removed
    expect(JSON.stringify(result)).not.toContain('"title"')
  })
})

// ============================================================================
// Comprehensive: Schema with ALL problematic patterns
// ============================================================================

describe('Comprehensive: All patterns combined', () => {
  it('should handle a schema with every problematic pattern', () => {
    const schema = {
      $id: 'https://example.com/test',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      title: 'TestSchema',
      additionalProperties: false,
      propertyOrdering: ['a', 'b', 'c'],
      properties: {
        ref_field: { $ref: '#/$defs/Inner' },
        nullable_field: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        const_field: { const: 'fixed' },
        default_field: { type: 'string', default: 'hello', title: 'DefaultField' },
        bounded: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 100 },
        union: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        merged: {
          allOf: [{ type: 'object', properties: { x: { type: 'string' } } }, { properties: { y: { type: 'integer' } } }],
        },
      },
      $defs: {
        Inner: {
          type: 'object',
          title: 'InnerModel',
          properties: {
            name: { type: 'string', default: 'test' },
          },
        },
      },
      if: { properties: { mode: { const: 'advanced' } } },
      then: { required: ['extra'] },
    }

    const result = makeGeminiCompatible(schema)

    // Phase 1+2: $ref inlined, $defs removed
    expect(result.properties.ref_field.type).toBe('object')
    expect(result.properties.ref_field.properties.name.type).toBe('string')
    expect(JSON.stringify(result)).not.toContain('$ref')
    expect(result.$defs).toBeUndefined()

    // Phase 3: anyOf[T, null] → nullable
    expect(result.properties.nullable_field.type).toBe('string')
    expect(result.properties.nullable_field.nullable).toBe(true)

    // Phase 3: oneOf → anyOf
    expect(result.properties.union.anyOf).toHaveLength(2)
    expect(result.properties.union.oneOf).toBeUndefined()

    // Phase 3: allOf → merged
    expect(result.properties.merged.properties.x.type).toBe('string')
    expect(result.properties.merged.properties.y.type).toBe('integer')
    expect(result.properties.merged.allOf).toBeUndefined()

    // Phase 4: const → enum
    expect(result.properties.const_field.enum).toEqual(['fixed'])
    expect(result.properties.const_field.const).toBeUndefined()

    // Phase 5: exclusive bounds → bounds
    expect(result.properties.bounded.minimum).toBe(0)
    expect(result.properties.bounded.maximum).toBe(100)
    expect(result.properties.bounded.exclusiveMinimum).toBeUndefined()
    expect(result.properties.bounded.exclusiveMaximum).toBeUndefined()

    // Phase 6: forbidden keys removed
    expect(JSON.stringify(result)).not.toContain('"title"')
    expect(JSON.stringify(result)).not.toContain('"default"')
    expect(result.additionalProperties).toBeUndefined()
    expect(result.propertyOrdering).toBeUndefined()
    expect(result.$id).toBeUndefined()
    expect(result.$schema).toBeUndefined()

    // Phase 7: conditional schemas removed
    expect(result.if).toBeUndefined()
    expect(result.then).toBeUndefined()

    // Core structure preserved
    expect(result.type).toBe('object')
    expect(Object.keys(result.properties)).toHaveLength(7)
  })

  it('should not modify the input schema', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: '#/$defs/Foo' },
      },
      $defs: { Foo: { type: 'string', title: 'Foo' } },
    }

    const original = JSON.stringify(schema)
    makeGeminiCompatible(schema)

    expect(JSON.stringify(schema)).toBe(original)
  })

  it('should handle empty/null input gracefully', () => {
    expect(makeGeminiCompatible({})).toEqual({})
    expect(makeGeminiCompatible(null as any)).toBe(null)
    expect(makeGeminiCompatible(undefined as any)).toBe(undefined)
  })
})
