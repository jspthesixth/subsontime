export const find = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing ${selector}`);
  }

  return element;
};

export const clone = (templateId: string) =>
  find<HTMLTemplateElement>(document, templateId).content.cloneNode(true) as DocumentFragment;
