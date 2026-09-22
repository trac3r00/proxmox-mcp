import { z } from "zod";
import { delimiter, isAbsolute, resolve } from "node:path";

const envSchema = z.object({
  PROXMOX_URL: z.url().refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash
      && ["", "/", "/api2/json", "/api2/json/"].includes(url.pathname);
  }),
  PROXMOX_TOKEN_ID: z.string().regex(/^[^\s!=@]+@[^\s!=@]+![^\s!=]+$/),
  PROXMOX_TOKEN_SECRET: z.string().min(1).regex(/^\S+$/),
  PROXMOX_VERIFY_TLS: z.enum(["true", "false"]).default("true"),
  PROXMOX_ALLOW_INSECURE_HTTP: z.enum(["true", "false"]).default("false"),
  PROXMOX_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(120_000),
  PROXMOX_CA_FILE: z.string().min(1).optional(),
  PROXMOX_FILE_ROOTS: z.string().min(1).refine(
    (value) => value.split(delimiter).every((path) => isAbsolute(path)),
    "Every file root must be an absolute path",
  ).optional(),
  PROXMOX_SCHEMA_URL: z.url().default("https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js"),
}).superRefine((values, context) => {
  const url = new URL(values.PROXMOX_URL);
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback && values.PROXMOX_ALLOW_INSECURE_HTTP !== "true") {
    context.addIssue({
      code: "custom",
      message: "Cleartext HTTP requires PROXMOX_ALLOW_INSECURE_HTTP=true",
      path: ["PROXMOX_URL"],
    });
  }
});

export type Config = {
  readonly baseUrl: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly verifyTls: boolean;
  readonly timeoutMs: number;
  readonly caFile?: string;
  readonly fileRoots: readonly string[];
  readonly schemaUrl: string;
};

export class ConfigurationError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Report field names only: Zod diagnostics can otherwise include input values.
    throw new ConfigurationError(`Invalid or missing configuration: ${
      [...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")
    }`);
  }
  const values = result.data;
  return {
    baseUrl: new URL(values.PROXMOX_URL).origin,
    tokenId: values.PROXMOX_TOKEN_ID,
    tokenSecret: values.PROXMOX_TOKEN_SECRET,
    verifyTls: values.PROXMOX_VERIFY_TLS === "true",
    timeoutMs: values.PROXMOX_TIMEOUT_MS,
    ...(values.PROXMOX_CA_FILE ? { caFile: values.PROXMOX_CA_FILE } : {}),
    fileRoots: values.PROXMOX_FILE_ROOTS
      ? values.PROXMOX_FILE_ROOTS.split(delimiter).map((path) => resolve(path))
      : [],
    schemaUrl: values.PROXMOX_SCHEMA_URL,
  };
}
