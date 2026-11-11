import type { GraphDoc } from "@coldtea/pr-lens-schema";
import { parseGraphDoc } from "@coldtea/pr-lens-schema";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";

/**
 * One store, three tables stacked, from a live run: a labelled removed key
 * between two of them. The route goes over the top, and its pill has to sit
 * on the top run, not on the tall vertical leg beside the cards.
 */
export const oneStoreGraph: GraphDoc = parseGraphDoc({
  ...minimalGraph,
  lenses: ["architecture", "data-model"],
  dataModel: {
  "stores": [
    {
      "id": "identity",
      "label": "Identity",
      "platform": "Postgres"
    }
  ],
  "tables": [
    {
      "id": "users",
      "label": "users",
      "store": "identity",
      "delta": "unchanged",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "unchanged"
        },
        {
          "name": "email",
          "type": "text",
          "key": "index",
          "delta": "unchanged"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "unchanged"
        },
        {
          "name": "created_at",
          "type": "timestamp",
          "delta": "unchanged"
        }
      ]
    },
    {
      "id": "login_sessions",
      "label": "login_sessions",
      "store": "identity",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "user_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "device",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "expires_at",
          "type": "timestamp",
          "delta": "added"
        }
      ]
    },
    {
      "id": "sessions",
      "label": "sessions",
      "store": "identity",
      "delta": "removed",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "removed"
        },
        {
          "name": "user_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "removed"
        },
        {
          "name": "expires_at",
          "type": "timestamp",
          "delta": "removed"
        }
      ]
    }
  ],
  "relations": [
    {
      "id": "login_sessions-user",
      "from": {
        "table": "login_sessions",
        "column": "user_id"
      },
      "to": {
        "table": "users",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "sessions-user",
      "from": {
        "table": "sessions",
        "column": "user_id"
      },
      "to": {
        "table": "users",
        "column": "id"
      },
      "delta": "removed",
      "label": "authenticated user sessions until now"
    }
  ]
},
});
