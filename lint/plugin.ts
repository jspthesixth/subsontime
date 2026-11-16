import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];

type Statement = { type: string; loc: { start: { line: number }; end: { line: number } } };

type Container = { type: string; body?: unknown; consequent?: unknown };

const statementLists = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
  "SwitchCase",
  "TSModuleBlock",
]);

const siblingsOf = (container: Container) =>
  (container.type === "SwitchCase" ? container.consequent : container.body) as Statement[];

const isDestructuring = (declarator: { id: { type: string } }) =>
  declarator.id.type === "ObjectPattern" || declarator.id.type === "ArrayPattern";

export const blankLineAfterDestructuring: Rule = {
  meta: {
    type: "layout",
    fixable: "whitespace",
    messages: { missing: "Leave a blank line after a destructuring statement." },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      VariableDeclaration(node) {
        if (!node.declarations.some(isDestructuring)) {
          return;
        }

        const statement = node.parent.type === "ExportNamedDeclaration" ? node.parent : node;
        const container = statement.parent as Container;

        if (!statementLists.has(container.type)) {
          return;
        }

        const siblings = siblingsOf(container);
        const next = siblings[siblings.indexOf(statement as Statement) + 1];
        const endLine = statement.loc.end.line;

        if (next === undefined || next.loc.start.line === endLine) {
          return;
        }

        const linesBetween = sourceCode.lines.slice(endLine, next.loc.start.line - 1);

        if (linesBetween.some((line) => line.trim() === "")) {
          return;
        }

        const lineAfter = sourceCode.getIndexFromLoc({ line: endLine + 1, column: 0 });

        context.report({
          node: statement,
          messageId: "missing",
          fix: (fixer) => fixer.insertTextAfterRange([lineAfter, lineAfter], "\n"),
        });
      },
    };
  },
};

export default {
  meta: { name: "subsontime" },
  rules: { "blank-line-after-destructuring": blankLineAfterDestructuring },
};
