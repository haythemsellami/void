/**
 * Type surface of npm/postinstall.mjs (see npm/lib.d.mts for why these
 * declarations exist).
 */

export interface PostinstallOptions {
  readonly env?: Record<string, string | undefined>;
  readonly platform?: string;
  readonly arch?: string;
  readonly pkgVersion?: string;
  readonly fetchImpl?: (url: string | URL) => Promise<unknown>;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly existsImpl?: (path: string) => boolean;
  readonly mkdir?: (path: string, opts: { recursive: boolean }) => Promise<void>;
  readonly writeFile?: (
    path: string,
    data: Buffer | string,
    opts?: { mode?: number },
  ) => Promise<void>;
}

export declare function postinstall(options?: PostinstallOptions): Promise<number>;
