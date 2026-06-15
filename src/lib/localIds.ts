let nextLocalId = 0;

export function createCollisionResistantId(prefix: string): string {
  nextLocalId = (nextLocalId + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now()}-${nextLocalId}`;
}
