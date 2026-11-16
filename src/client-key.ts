import ipaddr from "ipaddr.js";

export const addressKey = (address: string) => {
  if (!ipaddr.isValid(address)) {
    return address;
  }

  const ip = ipaddr.process(address);

  return ip.kind() === "ipv4"
    ? ip.toString()
    : `${ip.toNormalizedString().split(":").slice(0, 4).join(":")}::/64`;
};
