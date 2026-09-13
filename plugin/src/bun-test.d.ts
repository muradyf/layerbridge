/**
 * The slice of `bun:test` the plugin's pure-logic tests use, so `tsc --noEmit`
 * can check them without adding @types/bun to a Figma plugin.
 */
declare module "bun:test" {
  type Matchers = {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(length: number): void;
    toMatch(pattern: RegExp | string): void;
    toBeUndefined(): void;
    toBeTruthy(): void;
    not: Matchers;
  };
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): Matchers;
}
