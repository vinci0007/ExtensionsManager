import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

export type JsonSchema = Record<string, unknown>

export class JsonSchemaValidationError extends Error {
  constructor(message: string, readonly path: string) {
    super(message)
    this.name = 'JsonSchemaValidationError'
  }
}

export class JsonSchemaValidator {
  validate(schema: JsonSchema, value: unknown, path = '$'): void {
    this.validateNode(schema, value, path)
  }

  private validateNode(schema: JsonSchema, value: unknown, path: string): void {
    const schemaType = schema.type

    if (Array.isArray(schemaType)) {
      if (!schemaType.some((type) => this.matchesType(type, value))) {
        throw new JsonSchemaValidationError(`Expected one of types ${schemaType.join(', ')}`, path)
      }
    } else if (typeof schemaType === 'string' && !this.matchesType(schemaType, value)) {
      throw new JsonSchemaValidationError(`Expected type ${schemaType}`, path)
    }

    if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((item) => this.isEqual(item, value))) {
      throw new JsonSchemaValidationError(
        typeof schema.enumMessage === 'string' ? schema.enumMessage : 'Value must match one of enum values',
        path,
      )
    }

    if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new JsonSchemaValidationError(`String must have minimum length ${schema.minLength}`, path)
    }

    if (schema.required && Array.isArray(schema.required)) {
      if (!this.isObject(value)) {
        throw new JsonSchemaValidationError('Expected object for required properties', path)
      }

      for (const key of schema.required) {
        if (!(key in value)) {
          throw new JsonSchemaValidationError(`Missing required property ${String(key)}`, `${path}.${String(key)}`)
        }
      }
    }

    if (this.isObject(value) && schema.properties && this.isObject(schema.properties)) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        // undefined is treated as absent (JS optional-field semantics): an
        // optional property explicitly set to undefined must not hit enum checks.
        if (key in value && value[key] !== undefined) {
          this.validateNode(propertySchema as JsonSchema, value[key], `${path}.${key}`)
        }
      }
    }

    if (this.isObject(value)) {
      this.validateAdditionalProperties(schema, value, path)
    }

    if (schema.oneOf && Array.isArray(schema.oneOf)) {
      const results = schema.oneOf.map((candidate) => {
        try {
          this.validateNode(candidate as JsonSchema, value, path)
          return true
        } catch {
          return false
        }
      })

      if (!results.some(Boolean)) {
        throw new JsonSchemaValidationError('Value must match one of the oneOf schemas', path)
      }
    }

    if (Array.isArray(value) && schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        this.validateNode(schema.items as JsonSchema, value[index], `${path}[${index}]`)
      }
    }
  }

  private validateAdditionalProperties(schema: JsonSchema, value: Record<string, unknown>, path: string): void {
    const additionalProperties = schema.additionalProperties

    if (additionalProperties === false) {
      const properties = this.isObject(schema.properties) ? schema.properties : {}

      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          throw new JsonSchemaValidationError(`Unexpected property ${key}`, `${path}.${key}`)
        }
      }

      return
    }

    if (this.isObject(additionalProperties)) {
      const properties = this.isObject(schema.properties) ? schema.properties : {}

      for (const [key, propertyValue] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) {
          this.validateNode(additionalProperties as JsonSchema, propertyValue, `${path}.${key}`)
        }
      }
    }
  }

  private matchesType(type: string, value: unknown): boolean {
    switch (type) {
      case 'object':
        return this.isObject(value)
      case 'array':
        return Array.isArray(value)
      case 'string':
        return typeof value === 'string'
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'boolean':
        return typeof value === 'boolean'
      case 'null':
        return value === null
      default:
        return true
    }
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private isEqual(left: unknown, right: unknown): boolean {
    return Object.is(left, right)
  }
}

export const extensionManifestSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'version', 'protocolVersion', 'artifact', 'runtime', 'capabilities'],
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    description: { type: 'string' },
    version: { type: 'string', minLength: 1 },
    protocolVersion: {
      type: 'string',
      enum: ['1'],
      enumMessage: 'Unsupported protocolVersion: expected "1"',
    },
    extensionClass: { enum: ['transient', 'standard', 'resident'] },
    distribution: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { enum: ['directory', 'archive', 'package'] },
        source: { type: 'string' },
      },
      additionalProperties: false,
    },
    trust: {
      type: 'object',
      required: ['publisherId', 'trustDomain', 'issuedBy'],
      properties: {
        publisherId: { type: 'string', minLength: 1 },
        trustDomain: { enum: ['official', 'third-party', 'private'] },
        issuedBy: { type: 'string', minLength: 1 },
        signingIdentityId: { type: 'string' },
        issuedAt: { type: 'string' },
        expiresAt: { type: 'string' },
      },
      additionalProperties: false,
    },
    metadata: {
      type: 'object',
      properties: {
        publisher: partyInfoSchema(),
        author: partyInfoSchema(),
        publishedAt: { type: 'string' },
        updatedAt: { type: 'string' },
        statusCheck: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { enum: ['url', 'jsonrpc', 'custom'] },
            endpoint: { type: 'string' },
            method: { enum: ['GET', 'HEAD', 'POST'] },
            expectedStatus: { type: 'number' },
            timeoutMs: { type: 'number' },
          },
          additionalProperties: false,
        },
        supportsManualReinitialize: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
        authorSignature: signatureSchema(),
        publisherSignature: signatureSchema(),
      },
      additionalProperties: false,
    },
    artifact: {
      type: 'object',
      required: ['entry', 'kind'],
      properties: {
        kind: {
          enum: ['source-file', 'source-dir', 'module', 'package', 'binary', 'shared-library', 'wasm'],
        },
        entry: {
          oneOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
        build: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string' },
            output: { type: 'string' },
            cwd: { type: 'string' },
          },
          additionalProperties: false,
        },
        launch: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
            shell: { type: 'boolean' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            endpoint: { type: 'string' },
            transport: { type: 'string' },
            timeoutMs: { type: 'number' },
            auth: launchAuthSchema(),
          },
          additionalProperties: false,
        },
        integrity: { type: 'string' },
      },
      additionalProperties: false,
    },
    runtime: { enum: ['node', 'process', 'native', 'wasm', 'remote'] },
    activationEvents: { type: 'array', items: { type: 'string' } },
    settings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'type'],
        properties: {
          key: { type: 'string', minLength: 1 },
          type: { enum: ['string', 'number', 'boolean', 'enum'] },
          title: { type: 'string' },
          description: { type: 'string' },
          default: { type: ['string', 'number', 'boolean'] },
          enum: { type: 'array', items: { type: 'string', minLength: 1 } },
          min: { type: 'number' },
          max: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          binding: { type: 'string' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          interactionMode: { enum: ['unary', 'server-stream', 'client-stream', 'duplex', 'subscription'] },
          executionMode: { enum: ['ephemeral', 'session', 'persistent'] },
          realtimeClass: { enum: ['batch', 'interactive', 'realtime'] },
          concurrencyPolicy: { enum: ['single', 'shared', 'isolated'] },
          permission: { enum: ['prompt'] },
          resourceBudget: {
            type: 'object',
            properties: {
              timeoutMs: { type: 'number' },
              memoryMb: { type: 'number' },
              maxConcurrency: { type: 'number' },
              fuelPerTick: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    permissions: {
      // Open map: ExtensionPermissionSet allows arbitrary permission categories ([key: string]: unknown).
      type: 'object',
      properties: {
        filesystem: permissionDescriptorSchema(),
        network: permissionDescriptorSchema(),
        process: permissionDescriptorSchema(),
        device: permissionDescriptorSchema(),
      },
      additionalProperties: true,
    },
    signature: {
      ...signatureSchema(),
    },
  },
  additionalProperties: false,
}

export function validateExtensionManifestShape(manifest: unknown): asserts manifest is ExtensionManifest {
  new JsonSchemaValidator().validate(extensionManifestSchema, manifest)
}

function permissionDescriptorSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      access: { type: 'string', minLength: 1 },
      allow: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  }
}

function partyInfoSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      url: { type: 'string' },
    },
    additionalProperties: false,
  }
}

function launchAuthSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['kind', 'valueEnv'],
    properties: {
      kind: { enum: ['bearer', 'header'] },
      headerName: { type: 'string', minLength: 1 },
      valueEnv: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  }
}

function signatureSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['algorithm', 'keyId', 'value'],
    properties: {
      algorithm: { enum: ['ed25519', 'rsa-sha256'] },
      keyId: { type: 'string', minLength: 1 },
      value: { type: 'string', minLength: 1 },
      signedAt: { type: 'string' },
    },
    additionalProperties: false,
  }
}
