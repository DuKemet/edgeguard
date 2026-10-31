export function requestIdFrom(response: { locals?: Record<string, unknown> }): string {
  const value = response.locals?.requestId;
  return typeof value === "string" ? value : "unknown";
}
