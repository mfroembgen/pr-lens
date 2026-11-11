import type { GraphDoc, TableColumn } from "@coldtea/pr-lens-schema";
import { parseGraphDoc } from "@coldtea/pr-lens-schema";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";

const column = (name: string, delta: TableColumn["delta"], key?: TableColumn["key"]): TableColumn => ({
  name,
  type: name.endsWith("_id") || name === "id" ? "uuid" : "text",
  delta,
  ...(key === undefined ? {} : { key }),
});

const many = (count: number, delta: TableColumn["delta"]): TableColumn[] =>
  Array.from({ length: count }, (_, index) => column(`field_${String(index + 1).padStart(2, "0")}`, delta));

/**
 * Three tall tables from the sweep. A new table with 32 columns and one
 * with 64: every column is the change, so the card keeps them up to the
 * ceiling. A 30-column table gaining two: the keys and the two new columns
 * stay, the unchanged rest is sampled. The new table's foreign key sits
 * last, past the ceiling, and must still draw because a key ends on it.
 */
export const tallTablesGraph: GraphDoc = parseGraphDoc({
  ...minimalGraph,
  lenses: ["architecture", "data-model"],
  dataModel: {
    stores: [{ id: "analytics", label: "Analytics", platform: "Postgres" }],
    tables: [
      {
        id: "analytics_events",
        label: "analytics_events",
        store: "analytics",
        delta: "added",
        columns: [column("id", "added", "primary"), ...many(30, "added"), column("user_id", "added", "foreign")],
        files: [],
        badges: [],
      },
      {
        id: "sessions",
        label: "sessions",
        store: "analytics",
        delta: "modified",
        columns: [
          column("id", "unchanged", "primary"),
          ...many(14, "unchanged"),
          column("user_id", "unchanged", "foreign"),
          ...many(13, "unchanged").map((c) => ({ ...c, name: `extra_${c.name}` })),
          column("device_hash", "added"),
          column("locale", "added"),
        ],
        files: [],
        badges: [],
      },
      {
        id: "device_telemetry",
        label: "device_telemetry",
        store: "analytics",
        delta: "added",
        columns: [column("id", "added", "primary"), ...many(63, "added")],
        files: [],
        badges: [],
      },
      {
        id: "users",
        label: "users",
        store: "analytics",
        delta: "unchanged",
        columns: [column("id", "unchanged", "primary"), column("email", "unchanged")],
        files: [],
        badges: [],
      },
    ],
    relations: [
      { id: "events-user", from: { table: "analytics_events", column: "user_id" }, to: { table: "users", column: "id" }, delta: "added" },
      { id: "sessions-user", from: { table: "sessions", column: "user_id" }, to: { table: "users", column: "id" }, delta: "unchanged" },
    ],
  },
});
