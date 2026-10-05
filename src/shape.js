const MAX_DEPTH = 4;
const MAX_KEYS = 30;

function shapeOf(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', item: value.length ? shapeOf(value[0], depth + 1) : null };
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return { type: 'object', keys: {} };
    const keys = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) keys[key] = shapeOf(value[key], depth + 1);
    return { type: 'object', keys };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: typeof value };
}

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function conforms(shape, value, path = '$') {
  if (!shape) return [];
  const actual = actualType(value);
  if (shape.type === 'number' ? !['number', 'integer'].includes(actual) : actual !== shape.type) {
    return [`${path}: expected ${shape.type}, got ${actual}`];
  }
  if (shape.type === 'array') {
    return value.slice(0, 3).flatMap((item, i) => conforms(shape.item, item, `${path}[${i}]`));
  }
  if (shape.type === 'object') {
    return Object.entries(shape.keys || {}).flatMap(([key, sub]) =>
      key in value ? conforms(sub, value[key], `${path}.${key}`) : [`${path}.${key}: missing`],
    );
  }
  return [];
}

function describeShape(shape, depth = 0) {
  if (!shape) return 'empty';
  if (shape.type === 'array') return `array<${describeShape(shape.item, depth + 1)}>`;
  if (shape.type === 'object') {
    const keys = Object.keys(shape.keys || {});
    return depth > 0 ? 'object' : `{${keys.join(', ')}}`;
  }
  return shape.type;
}

module.exports = { shapeOf, conforms, describeShape };
