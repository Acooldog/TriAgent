export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
}

export function validateJsonSchema(schema: unknown, path = "Schema"): asserts schema is JsonSchema {
  if (!isRecord(schema)) throw new Error(`${path} 必须是对象。`);
  const allowedTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  if (schema.type !== undefined && !allowedTypes.includes(String(schema.type))) throw new Error(`${path}.type 无效。`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(isNonEmptyString))) throw new Error(`${path}.required 无效。`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error(`${path}.additionalProperties 无效。`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`${path}.enum 无效。`);
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${path}.properties 无效。`);
    for (const [key, child] of Object.entries(schema.properties)) validateJsonSchema(child, `${path}.properties.${key}`);
  }
  if (schema.items !== undefined) validateJsonSchema(schema.items, `${path}.items`);
}

export function validateJsonValue(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) errors.push(`${path} 不在允许值范围内`);
  if (schema.type && !matchesType(schema.type, value)) errors.push(`${path} 类型应为 ${schema.type}`);
  if (schema.type === "object" && isRecord(value)) {
    for (const required of schema.required ?? []) if (!(required in value)) errors.push(`${path}.${required} 必填`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!schema.properties?.[key]) errors.push(`${path}.${key} 不允许`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validateJsonValue(child, value[key], `${path}.${key}`));
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...validateJsonValue(schema.items!, item, `${path}[${index}]`)));
  return errors;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}
