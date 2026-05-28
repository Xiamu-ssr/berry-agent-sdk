// ============================================================
// @berry-agent/core — JSON + Zod parse helpers
// ============================================================
// Two layered helpers for the "read a file, parse JSON, validate with zod"
// pattern that recurs across stores. They produce error messages that
// identify *which* file/source failed, instead of bare "Unexpected token"
// or path-less zod issues — which becomes essential when a corrupt
// session/team/credential file would otherwise be unidentifiable.

import { ZodError, type z } from 'zod';
import { errorMessage, joinZodPath, zodIssueMessage } from '@berry-agent/small-shared-core';

/**
 * Validate `value` against `schema`. On a ZodError, throw a human-readable
 * `Invalid {source}.path.to.field: <msg>` instead of the raw issue list.
 * Other errors propagate untouched.
 */
export function parseSchema<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new Error(`Invalid ${joinZodPath(source, issue?.path ?? [])}: ${zodIssueMessage(issue, 'invalid value')}`);
    }
    throw error;
  }
}

/**
 * Parse `raw` as JSON and validate the result against `schema`. JSON parse
 * failures throw `Failed to parse {source}: <msg>`; schema failures throw
 * the same shape as `parseSchema`.
 */
export function parseJsonWithSchema<T>(raw: string, schema: z.ZodType<T>, source: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${source}: ${errorMessage(error)}`);
  }
  return parseSchema(schema, parsed, source);
}
