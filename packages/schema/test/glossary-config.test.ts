import { z } from "zod";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { Config } from "../src/config.js";
import { SCHEMA_VERSION } from "../src/version.js";

const schema = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(new URL("../json-schema/config.schema.json", import.meta.url), "utf8")));
const validate = new Ajv2020({ strict: false }).compile(schema);

describe("glossary", () => {
  it("is absent unless the repository names a file", () => {
    const input = { schemaVersion: SCHEMA_VERSION };
    expect(Config.parse(input).glossary).toBeUndefined();
    expect(validate(input)).toBe(true);
  });

  it.each(["CONTEXT.md", "docs/CONTEXT.md#Language"])("accepts a path, with or without a heading, in Zod and the published JSON Schema: %s", (glossary) => {
    const input = { schemaVersion: SCHEMA_VERSION, glossary };
    expect(Config.parse(input).glossary).toBe(glossary);
    expect(validate(input)).toBe(true);
  });

  it.each(["", 1, null, ["CONTEXT.md"], { path: "CONTEXT.md" }])("rejects anything but a non-empty string: %j", (glossary) => {
    const input = { schemaVersion: SCHEMA_VERSION, glossary };
    expect(Config.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  });
});
