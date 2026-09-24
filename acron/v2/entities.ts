import { Api } from "teleproto";
import { returnBigInt } from "teleproto/Helpers";

/**
 * MessageEntity class names exposed by the current Teleproto build. Only these
 * are accepted when persisting or reviving stored entity JSON, so a tampered or
 * outdated database cannot instantiate arbitrary TL constructors.
 */
const ENTITY_CLASS_NAMES = new Set(Object.keys(Api).filter(name => /^MessageEntity[A-Z]/.test(name)));

/** Entity fields carrying 64-bit TL integers that must keep full precision. */
const LONG_FIELDS = new Set(["documentId", "userId"]);
const isDecimalString = (value: unknown): value is string => typeof value === "string" && /^-?\d+$/.test(value);

function entityClassName(entity: unknown): string | undefined {
  const name = (entity as { className?: unknown })?.className;
  return typeof name === "string" && ENTITY_CLASS_NAMES.has(name) ? name : undefined;
}

/**
 * Serializes a replied message's `MessageEntity[]` into JSON-safe TL JSON.
 * `big-integer` fields (e.g. `documentId`, `userId`) serialize through their
 * `toJSON` as decimal strings, so precision survives a JSON round-trip.
 */
export function serializeMessageEntities(entities: unknown): unknown[] | undefined {
  if (!Array.isArray(entities)) return undefined;
  const serialized: unknown[] = [];
  for (const entity of entities) {
    if (!entityClassName(entity)) continue;
    serialized.push(JSON.parse(JSON.stringify(entity)));
  }
  return serialized.length ? serialized : undefined;
}

/**
 * Revives stored TL entity JSON back into `Api.MessageEntity` instances.
 * Unknown class names, malformed entries and constructor failures are skipped
 * instead of aborting the whole send.
 */
export function reviveMessageEntities(json: unknown): Api.TypeMessageEntity[] | undefined {
  if (!Array.isArray(json)) return undefined;
  const revived: Api.TypeMessageEntity[] = [];
  for (const item of json) {
    const className = entityClassName(item);
    if (!className) continue;
    const Constructor = (Api as unknown as Record<string, unknown>)[className];
    if (typeof Constructor !== "function") continue;
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (key === "className") continue;
      // Rebuild long fields as TL integers instead of relying on constructor coercion.
      args[key] = LONG_FIELDS.has(key) && isDecimalString(value) ? returnBigInt(value) : value;
    }
    try {
      revived.push(new (Constructor as new (args: Record<string, unknown>) => Api.TypeMessageEntity)(args));
    } catch {
      // Skip entities the current Teleproto build cannot reconstruct.
    }
  }
  return revived.length ? revived : undefined;
}
