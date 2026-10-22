// Kopie von kette-engineering/lib/validate.mjs, scripts/release.mjs prüft Gleichheit
// Small JSON Schema checker for the project profile, covers only the keywords the schema uses; messages are English because the CLI shows them
export function validate(schema, value, path = '$') {
  const errors = [];
  const at = (p, msg) => errors.push(`${p}: ${msg}`);
  if ('const' in schema && value !== schema.const) at(path, `must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) at(path, `unknown value ${JSON.stringify(value)}, allowed: ${schema.enum.join(', ')}`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') at(path, 'must be a string');
    else if (schema.minLength && value.length < schema.minLength) at(path, 'must not be empty');
    else if (schema.pattern && !new RegExp(schema.pattern).test(value)) at(path, `${JSON.stringify(value)} has an invalid format`);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) at(path, 'must be a list');
    else {
      if (schema.minItems && value.length < schema.minItems) at(path, `needs at least ${schema.minItems} entry`);
      if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) at(path, 'has duplicate entries');
      if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
    }
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) at(path, 'must be an object');
    else {
      for (const k of schema.required || []) if (!(k in value)) at(path, `required field ${k} is missing`);
      for (const [k, v] of Object.entries(value)) {
        if (schema.properties && k in schema.properties) errors.push(...validate(schema.properties[k], v, `${path}.${k}`));
        else if (schema.additionalProperties === false) at(path, `unknown field ${k}`);
      }
    }
  }
  return errors;
}
