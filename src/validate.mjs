// Kopie von kette-engineering/lib/validate.mjs, scripts/release.mjs prüft Gleichheit
// Kleiner JSON-Schema-Prüfer für das Projektprofil, deckt nur die im Schema genutzten Schlüsselwörter ab
export function validate(schema, value, path = '$') {
  const errors = [];
  const at = (p, msg) => errors.push(`${p}: ${msg}`);
  if ('const' in schema && value !== schema.const) at(path, `muss ${JSON.stringify(schema.const)} sein`);
  if (schema.enum && !schema.enum.includes(value)) at(path, `unbekannter Wert ${JSON.stringify(value)}, erlaubt: ${schema.enum.join(', ')}`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') at(path, 'muss Text sein');
    else if (schema.minLength && value.length < schema.minLength) at(path, 'darf nicht leer sein');
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) at(path, 'muss eine Liste sein');
    else {
      if (schema.minItems && value.length < schema.minItems) at(path, `braucht mindestens ${schema.minItems} Eintrag`);
      if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) at(path, 'enthält doppelte Einträge');
      if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
    }
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) at(path, 'muss ein Objekt sein');
    else {
      for (const k of schema.required || []) if (!(k in value)) at(path, `Pflichtfeld ${k} fehlt`);
      for (const [k, v] of Object.entries(value)) {
        if (schema.properties && k in schema.properties) errors.push(...validate(schema.properties[k], v, `${path}.${k}`));
        else if (schema.additionalProperties === false) at(path, `unbekanntes Feld ${k}`);
      }
    }
  }
  return errors;
}
