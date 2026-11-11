import type { GraphDoc } from "@coldtea/pr-lens-schema";
import { parseGraphDoc } from "@coldtea/pr-lens-schema";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";

/**
 * Two stores side by side, drawn from a live run: a labelled key between
 * ADJACENT lanes. The corridor between them is 52px, and the label's pill is
 * about 190px, so a route through that corridor has no straight run to carry
 * the words without laying them across the cards either side.
 */
export const twoStoresGraph: GraphDoc = parseGraphDoc({
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
    }
  ],
  "tables": [
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
          "delta": "removed"
        },
        {
          "name": "created_at",
          "type": "timestamptz",
          "delta": "unchanged"
        }
      ]
    },
    {
      "id": "organizations",
      "label": "organizations",
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
          "delta": "added"
        },
        {
          "name": "name",
          "type": "text",
          "delta": "added"
        },
        {
          "name": "owner_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "plan",
          "type": "plan",
          "delta": "added"
        },
        {
          "name": "stripe_customer_id",
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
      "id": "memberships",
      "label": "memberships",
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
          "name": "org_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "user_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "role",
          "type": "member_role",
          "delta": "added"
        },
        {
          "name": "accepted_at",
          "type": "timestamptz",
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
          "delta": "removed"
        },
        {
          "name": "org_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
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
          "name": "org_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "added"
        },
        {
          "name": "subscription_id",
          "type": "uuid",
          "key": "foreign",
          "delta": "unchanged"
        },
        {
          "name": "amount_cents",
          "type": "bigint",
          "delta": "modified",
          "previousType": "int"
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
        }
      ]
    }
  ],
  "relations": [
    {
      "id": "org-owner",
      "from": {
        "table": "organizations",
        "column": "owner_id"
      },
      "to": {
        "table": "users",
        "column": "id"
      },
      "delta": "added",
      "enforced": true
    },
    {
      "id": "membership-org",
      "from": {
        "table": "memberships",
        "column": "org_id"
      },
      "to": {
        "table": "organizations",
        "column": "id"
      },
      "delta": "added",
      "enforced": true
    },
    {
      "id": "membership-user",
      "from": {
        "table": "memberships",
        "column": "user_id"
      },
      "to": {
        "table": "users",
        "column": "id"
      },
      "delta": "added",
      "enforced": true
    },
    {
      "id": "sub-user",
      "from": {
        "table": "subscriptions",
        "column": "user_id"
      },
      "to": {
        "table": "users",
        "column": "id"
      },
      "delta": "removed",
      "label": "billed to the user until now",
      "enforced": true
    },
    {
      "id": "sub-org",
      "from": {
        "table": "subscriptions",
        "column": "org_id"
      },
      "to": {
        "table": "organizations",
        "column": "id"
      },
      "delta": "added",
      "enforced": true
    },
    {
      "id": "invoice-org",
      "from": {
        "table": "invoices",
        "column": "org_id"
      },
      "to": {
        "table": "organizations",
        "column": "id"
      },
      "delta": "added",
      "enforced": true
    },
    {
      "id": "invoice-sub",
      "from": {
        "table": "invoices",
        "column": "subscription_id"
      },
      "to": {
        "table": "subscriptions",
        "column": "id"
      },
      "delta": "unchanged",
      "enforced": true
    }
  ]
},
});
