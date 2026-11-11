import type { GraphDoc } from "@coldtea/pr-lens-schema";
import { parseGraphDoc } from "@coldtea/pr-lens-schema";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";

/**
 * Thirteen tables from a live run: twelve keys from three stores all land on
 * tenants.id, and the stores carry no order. Written first, the hub's store
 * had sat on the left, so every key from the right climbed over the top and
 * twelve heads fanned on one row.
 */
export const tenantsGraph: GraphDoc = parseGraphDoc({
  ...minimalGraph,
  lenses: ["architecture", "data-model"],
  dataModel: {
  "stores": [
    {
      "id": "identity",
      "label": "Identity",
      "platform": "Postgres"
    },
    {
      "id": "billing",
      "label": "Billing",
      "platform": "Postgres"
    },
    {
      "id": "platform",
      "label": "Platform",
      "platform": "Postgres"
    }
  ],
  "tables": [
    {
      "id": "tenants",
      "label": "tenants",
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
          "name": "slug",
          "type": "citext",
          "key": "index",
          "delta": "added"
        },
        {
          "name": "plan",
          "type": "text",
          "delta": "added"
        }
      ]
    },
    {
      "id": "users",
      "label": "users",
      "store": "identity",
      "delta": "modified",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "unchanged"
        },
        {
          "name": "email",
          "type": "citext",
          "key": "index",
          "delta": "unchanged"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "unchanged"
        },
        {
          "name": "stripe_customer_id",
          "type": "text",
          "delta": "unchanged"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "unchanged"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        }
      ]
    },
    {
      "id": "sessions",
      "label": "sessions",
      "store": "identity",
      "delta": "modified",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "unchanged"
        },
        {
          "name": "user_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "unchanged"
        },
        {
          "name": "expires_at",
          "type": "timestamptz",
          "delta": "unchanged"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        }
      ]
    },
    {
      "id": "subscriptions",
      "label": "subscriptions",
      "store": "billing",
      "delta": "modified",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "unchanged"
        },
        {
          "name": "user_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "unchanged"
        },
        {
          "name": "stripe_subscription_id",
          "type": "text",
          "delta": "unchanged"
        },
        {
          "name": "status",
          "type": "sub_status",
          "delta": "unchanged"
        },
        {
          "name": "current_period_end",
          "type": "timestamptz",
          "delta": "unchanged"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        }
      ]
    },
    {
      "id": "invoices",
      "label": "invoices",
      "store": "billing",
      "delta": "modified",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "unchanged"
        },
        {
          "name": "subscription_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "unchanged"
        },
        {
          "name": "amount_cents",
          "type": "int",
          "delta": "unchanged"
        },
        {
          "name": "status",
          "type": "invoice_status",
          "delta": "unchanged"
        },
        {
          "name": "issued_at",
          "type": "timestamptz",
          "delta": "unchanged"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        }
      ]
    },
    {
      "id": "projects",
      "label": "projects",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "project_members",
      "label": "project_members",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "webhooks",
      "label": "webhooks",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "webhook_deliveries",
      "label": "webhook_deliveries",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "api_keys",
      "label": "api_keys",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "audit_logs",
      "label": "audit_logs",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "notifications",
      "label": "notifications",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    },
    {
      "id": "settings",
      "label": "settings",
      "store": "platform",
      "delta": "added",
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "key": "primary",
          "delta": "added"
        },
        {
          "name": "tenant_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "added"
        }
      ]
    }
  ],
  "relations": [
    {
      "id": "users-tenant",
      "from": {
        "table": "users",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "sessions-tenant",
      "from": {
        "table": "sessions",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "subscriptions-tenant",
      "from": {
        "table": "subscriptions",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "invoices-tenant",
      "from": {
        "table": "invoices",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "projects-tenant",
      "from": {
        "table": "projects",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "project_members-tenant",
      "from": {
        "table": "project_members",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "webhooks-tenant",
      "from": {
        "table": "webhooks",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "webhook_deliveries-tenant",
      "from": {
        "table": "webhook_deliveries",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "api_keys-tenant",
      "from": {
        "table": "api_keys",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "audit_logs-tenant",
      "from": {
        "table": "audit_logs",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "notifications-tenant",
      "from": {
        "table": "notifications",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    },
    {
      "id": "settings-tenant",
      "from": {
        "table": "settings",
        "column": "tenant_id"
      },
      "to": {
        "table": "tenants",
        "column": "id"
      },
      "delta": "added"
    }
  ]
},
});
