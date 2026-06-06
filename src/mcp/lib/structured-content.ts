/**
 * Single, reviewed home for the MCP SDK `structuredContent` boundary cast.
 *
 * ## Why a cast is unavoidable here
 *
 * `@modelcontextprotocol/sdk` types a tool result's `structuredContent` as an
 * index signature — `{ [x: string]: unknown }` — because the wire contract is
 * "any JSON object". Our service/domain types (Task, Project, TopologyReport,
 * ranking payloads, etc.) are precise interfaces, NOT index-signature types, so
 * TypeScript will not structurally assign them to `{ [x: string]: unknown }`
 * (a known limitation: interfaces lack an implicit index signature). Every tool
 * handler therefore needs exactly one assertion at the moment it hands a typed
 * value to the SDK.
 *
 * Rather than scatter `value as unknown as { [x: string]: unknown }` across ~58
 * call sites in the local and remote handlers, the cast lives ONCE here. The
 * helpers below keep the *input* fully typed (so callers still get checking on
 * the value they construct) and isolate the lossy step to a single reviewed
 * line. If the SDK ever tightens or relaxes this type, this is the only place
 * that changes.
 *
 * Project 37 phase-3 (#767).
 */

/**
 * The exact shape the MCP SDK expects for a tool result's `structuredContent`
 * field: an open JSON object.
 */
export type StructuredContent = { [x: string]: unknown };

/**
 * Wrap a typed value as MCP `structuredContent`.
 *
 * The generic parameter keeps the call site type-checked — `value` must be a
 * concrete (object-shaped) type — while this function performs the single,
 * SDK-mandated widening to the index-signature type the SDK requires. This is
 * the ONLY sanctioned `as unknown as { [x: string]: unknown }` in the MCP
 * layer; see the module header for why it cannot be avoided.
 */
export function toStructuredContent<T extends object>(value: T): StructuredContent {
  // SDK-boundary cast (isolated): interfaces don't satisfy the SDK's index
  // signature even though they are valid JSON objects at runtime.
  return value as unknown as StructuredContent;
}
