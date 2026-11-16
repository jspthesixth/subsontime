import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { blankLineAfterDestructuring } from "./plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

ruleTester.run("blank-line-after-destructuring", blankLineAfterDestructuring, {
  valid: [
    "const { a } = x;\n\nconst b = a;",
    "const [a] = x;\n\nfoo(a);",
    "const a = x;\nconst b = a;",
    "function f() {\n  const { a } = x;\n}",
    "for (const [key, value] of entries) {\n  use(key, value);\n}",
    "for (const { a } of list) use(a);",
    "const { a } = x;\n\n// note\nfoo(a);",
    "export const { a } = x;\n\nexport const b = a;",
    "switch (k) {\n  case 1:\n    const { a } = x;\n\n    foo(a);\n}",
  ],
  invalid: [
    {
      code: "const fit = (cues: Cue[]) => {\n  const { start, end } = windowOf(cues);\n  const length = end - start;\n\n  return length;\n};",
      output:
        "const fit = (cues: Cue[]) => {\n  const { start, end } = windowOf(cues);\n\n  const length = end - start;\n\n  return length;\n};",
      errors: [{ messageId: "missing", line: 2 }],
    },
    {
      code: "const [first] = list;\nfoo(first);",
      output: "const [first] = list;\n\nfoo(first);",
      errors: 1,
    },
    {
      code: "const { a } = x;\nconst [b] = a;\nreturnIt(b);",
      output: "const { a } = x;\n\nconst [b] = a;\n\nreturnIt(b);",
      errors: 2,
    },
    {
      code: "const {\n  a,\n  b,\n} = x;\nfoo(a, b);",
      output: "const {\n  a,\n  b,\n} = x;\n\nfoo(a, b);",
      errors: 1,
    },
    {
      code: "const { a } = x;\n// note\nfoo(a);",
      output: "const { a } = x;\n\n// note\nfoo(a);",
      errors: 1,
    },
    {
      code: "const { a } = x; // note\nfoo(a);",
      output: "const { a } = x; // note\n\nfoo(a);",
      errors: 1,
    },
    {
      code: "export const { a } = x;\nexport const b = a;",
      output: "export const { a } = x;\n\nexport const b = a;",
      errors: 1,
    },
    {
      code: "const a = 1, { b } = x;\nfoo(a, b);",
      output: "const a = 1, { b } = x;\n\nfoo(a, b);",
      errors: 1,
    },
    {
      code: "switch (k) {\n  case 1:\n    const { a } = x;\n    foo(a);\n}",
      output: "switch (k) {\n  case 1:\n    const { a } = x;\n\n    foo(a);\n}",
      errors: 1,
    },
  ],
});
