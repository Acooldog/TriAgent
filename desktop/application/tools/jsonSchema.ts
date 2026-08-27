export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
}

export function validateJsonSchema(schema: unknown, path = "Schema"): asserts schema is JsonSchema {
  validateSchemaNode(schema, path, new WeakSet<object>(), 0);
}

function validateSchemaNode(schema: unknown, path: string, ancestors: WeakSet<object>, depth: number): asserts schema is JsonSchema {
  if (!isRecord(schema)) throw new Error(`${path} 必须是对象。`);
  if (depth > 64) throw new Error(`${path} 嵌套层级过深。`);
  if (ancestors.has(schema)) throw new Error(`${path} 不能循环引用。`);
  ancestors.add(schema);
  const allowedTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  if (schema.type !== undefined && !allowedTypes.includes(String(schema.type))) throw new Error(`${path}.type 无效。`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(isNonEmptyString))) throw new Error(`${path}.required 无效。`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error(`${path}.additionalProperties 无效。`);
  const enumInvalid = schema.enum !== undefined && (
    !Array.isArray(schema.enum)
    || !schema.enum.every((item) => isJsonCompatible(item, new WeakSet<object>()))
  );
  if (enumInvalid) throw new Error(`${path}.enum 无效。`);
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${path}.properties 无效。`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaNode(child, `${path}.properties.${key}`, ancestors, depth + 1);
  }
  if (schema.items !== undefined) validateSchemaNode(schema.items, `${path}.items`, ancestors, depth + 1);
  ancestors.delete(schema);
}

export function validateJsonValue(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((candidate) => safeJsonEqual(candidate, value))) errors.push(`${path} 不在允许值范围内`);
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
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function safeJsonEqual(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function isJsonCompatible(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value) ? value.every((item) => isJsonCompatible(item, ancestors)) : Object.values(value).every((item) => isJsonCompatible(item, ancestors));
  ancestors.delete(value);
  return valid;
}
