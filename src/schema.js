const { deref } = require('./openapi');

const MAX_DEPTH = 8;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function validate(spec, rawSchema, value, path = '$', depth = 0) {
  const schema = deref(spec, rawSchema);
  if (!schema || depth > MAX_DEPTH) return [];

  if (value === null && schema.nullable) return [];

  if (schema.allOf) {
    return schema.allOf.flatMap((s) => validate(spec, s, value, path, depth + 1));
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (schema[key]) {
      const attempts = schema[key].map((s) => validate(spec, s, value, path, depth + 1));
      return attempts.some((errors) => errors.length === 0) ? [] : attempts[0];
    }
  }

  const errors = [];
  if (schema.type && !matchesType(schema.type, value)) {
    return [`${path}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value not in enum`);
  }
  if (schema.type === 'object' || schema.properties) {
    if (typeOf(value) !== 'object') return [`${path}: expected object, got ${typeOf(value)}`];
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required property is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validate(spec, sub, value[key], `${path}.${key}`, depth + 1));
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.slice(0, 5).forEach((item, i) => {
      errors.push(...validate(spec, schema.items, item, `${path}[${i}]`, depth + 1));
    });
  }
  return errors;
}

module.exports = { validate };
