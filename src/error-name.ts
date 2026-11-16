export const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
