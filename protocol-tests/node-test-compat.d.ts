declare module "node:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- vendored shim; node:test passes a context the protocol tests don't use
  export interface TestContext {}
  export default function test(
    name: string,
    fn: (context: TestContext) => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: RegExp, message?: string): void;
    rejects(
      input: Promise<unknown> | (() => Promise<unknown>),
      error?: RegExp,
      message?: string,
    ): Promise<void>;
    doesNotReject(
      input: Promise<unknown> | (() => Promise<unknown>),
      message?: string,
    ): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}


declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
    digest(encoding: "hex"): string;
  };
}
