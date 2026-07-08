export type OpenApiDocument = Record<string, unknown>;

export function extractSchemas(openApiDoc: OpenApiDocument): Record<string, unknown> {
  const components = openApiDoc.components;
  if (!components || typeof components !== "object") {
    return {};
  }

  const schemas = (components as Record<string, unknown>).schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    return {};
  }

  return { ...(schemas as Record<string, unknown>) };
}

export function schemaBundleForTopLevel(
  schemas: Record<string, unknown>,
  topLevel: string,
): Record<string, unknown> {
  const root = schemas[topLevel];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(`Schema not found for top-level type: ${topLevel}`);
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...(root as Record<string, unknown>),
    definitions: schemas,
  };
}

export function pickTopLevelSchema(schemas: Record<string, unknown>, preferred?: string): string {
  if (preferred) {
    if (!(preferred in schemas)) {
      throw new Error(`Schema not found for top-level type: ${preferred}`);
    }
    return preferred;
  }

  const names = Object.keys(schemas);
  if (names.length === 0) {
    throw new Error("No schemas available for codegen");
  }

  const first = names[0];
  if (!first) {
    throw new Error("No schemas available for codegen");
  }
  return first;
}
