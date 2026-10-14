/**
 * Type surface of npm/lib.mjs for the TypeScript suite
 * (tests/npm-stub.test.ts imports the plain-Node ESM module — it must stay
 * dependency-free JS for postinstall, so types live beside it).
 */

export declare const DEFAULT_REPO: string;
export declare const INSTALL_SH_ONE_LINER: string;

export declare function targetFor(platform: string, arch: string): string | null;

export declare function resolveVersion(envVersion: string | undefined, pkgVersion: string): string;

export declare function releaseBaseUrl(repo: string, version: string): string;

export declare function assetUrl(baseUrl: string, assetName: string): string;

export declare function parseExpectedChecksum(
  sumsText: string,
  artifactName: string,
): string | null;

export declare function checksumOk(
  sumsText: string,
  artifactName: string,
  actualHex: string,
): boolean;

export declare function sha256Hex(buffer: Buffer): string;

export declare function installRoot(env: Record<string, string | undefined>): string;

export declare function binaryPath(root: string, version: string, target: string): string;

export interface PlanInstallInput {
  readonly platform: string;
  readonly arch: string;
  readonly envVersion: string | undefined;
  readonly pkgVersion: string;
  readonly repo: string | undefined;
  readonly releaseUrlOverride: string | undefined;
}

export interface PlanInstallOk {
  readonly ok: true;
  readonly target: string;
  readonly version: string;
  readonly baseUrl: string;
  readonly artifactName: string;
  readonly sumsUrl: string;
  readonly binaryUrl: string;
}

export interface PlanInstallUnsupported {
  readonly ok: false;
  readonly reason: "unsupported_platform";
  readonly platform: string;
  readonly arch: string;
}

export declare function planInstall(
  input: PlanInstallInput,
): PlanInstallOk | PlanInstallUnsupported;
