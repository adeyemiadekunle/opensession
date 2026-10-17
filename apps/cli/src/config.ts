import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface Config {
  gatewayUrl: string;
  webUrl: string;
  token?: string;
  defaultModel?: string; // "provider/model"
}

// Release builds compile in the deployment's addresses (tsup.config.ts, from
// OPENSESSION_GATEWAY_URL / OPENSESSION_WEB_URL at build time); from source they're
// localhost. `opensession config` and the same variables at run time override them.
declare const __DEFAULT_GATEWAY_URL__: string;
declare const __DEFAULT_WEB_URL__: string;

export const DEFAULTS: Config = {
  gatewayUrl: typeof __DEFAULT_GATEWAY_URL__ === "string" ? __DEFAULT_GATEWAY_URL__ : "http://localhost:8787",
  webUrl: typeof __DEFAULT_WEB_URL__ === "string" ? __DEFAULT_WEB_URL__ : "http://localhost:5173",
};

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENSESSION_CONFIG_DIR) return env.OPENSESSION_CONFIG_DIR;
  if (platform() === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opensession");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opensession");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = join(configDir(env), "config.json");
  let saved: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* ignore a broken file */
    }
  }
  return {
    ...DEFAULTS,
    ...saved,
    ...(env.OPENSESSION_GATEWAY_URL ? { gatewayUrl: env.OPENSESSION_GATEWAY_URL } : {}),
    ...(env.OPENSESSION_WEB_URL ? { webUrl: env.OPENSESSION_WEB_URL } : {}),
    ...(env.OPENSESSION_TOKEN ? { token: env.OPENSESSION_TOKEN } : {}),
  };
}

export function saveConfig(patch: Partial<Config>, env: NodeJS.ProcessEnv = process.env): Config {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  let saved: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* overwrite */
    }
  }
  const next = { ...saved, ...patch };
  for (const k of Object.keys(next) as (keyof Config)[]) if (next[k] === undefined) delete next[k];
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // the file holds an access token
  } catch {
    /* Windows */
  }
  return { ...DEFAULTS, ...next } as Config;
}
