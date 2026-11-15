export const move = <T>(items: T[], from: number, to: number) => {
  const item = items[from];

  return item === undefined ? items : items.toSpliced(from, 1).toSpliced(to, 0, item);
};
