import { isIP } from "node:net";

const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));

const groupCount = (groups: string[]) =>
  groups.reduce((total, group) => total + (group.includes(".") ? 2 : 1), 0);

export const addressKey = (address: string) => {
  const bare = address.replace(/%.*$/, "");

  if (isIP(bare) !== 6) {
    return address;
  }

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1];

  if (mapped !== undefined) {
    return mapped;
  }

  const [head = "", tail] = bare.split("::");
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const zeros = Array.from({ length: 8 - groupCount(left) - groupCount(right) }, () => "0");
  const prefix = [...left, ...zeros, ...right].slice(0, 4);

  return `${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
};
