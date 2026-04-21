import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import NodeRSA from "node-rsa";
import { Service } from "typedi";
import YAML from "yaml";
import {
  configSchema,
  type ConfigSource,
  type IConfig
} from "../headers/config";

const projectRoot = path.resolve(__dirname, "../..");
const configYamlPath = path.join(projectRoot, "config.yaml");
const envPath = path.join(projectRoot, ".env");
const envLocalPath = path.join(projectRoot, ".env.local");

async function readOptionalFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function mergeConfig(base: ConfigSource, override: ConfigSource): ConfigSource {
  return {
    ...base,
    ...override,
    listen: {
      ...base.listen,
      ...override.listen
    },
    jwt:
      base.jwt || override.jwt
        ? {
            ...base.jwt,
            ...override.jwt
          }
        : undefined
  };
}

function pickFirst(...values: Array<string | undefined>) {
  return values.find((value) => value !== undefined);
}

function envToConfig(env: NodeJS.ProcessEnv): ConfigSource {
  const listenPort = pickFirst(env.LISTEN_PORT, env.PORT);
  const listenHostname = pickFirst(env.LISTEN_HOSTNAME, env.HOSTNAME);
  const appEnv = pickFirst(env.APP_ENV, env.NODE_ENV, env.ENV);
  const jwtPrivateKey = pickFirst(
    env.JWT_PRIVATE_KEY,
    env.JWT_PRIVATE_KEY_BASE64
  );
  const jwtPublicKey = pickFirst(env.JWT_PUBLIC_KEY, env.JWT_PUBLIC_KEY_BASE64);

  return {
    ...(listenPort || listenHostname
      ? {
          listen: {
            ...(listenPort ? { port: listenPort } : {}),
            ...(listenHostname ? { hostname: listenHostname } : {})
          }
        }
      : {}),
    ...(appEnv ? { env: appEnv } : {}),
    ...(jwtPrivateKey || jwtPublicKey
      ? {
          jwt: {
            ...(jwtPrivateKey ? { privateKey: jwtPrivateKey } : {}),
            ...(jwtPublicKey ? { publicKey: jwtPublicKey } : {})
          }
        }
      : {})
  };
}

@Service()
export class ConfigService {
  config!: IConfig;

  async loadConfig() {
    const [yamlText, envText, envLocalText] = await Promise.all([
      readOptionalFile(configYamlPath),
      readOptionalFile(envPath),
      readOptionalFile(envLocalPath)
    ]);

    const yamlConfig = yamlText ? (YAML.parse(yamlText) as ConfigSource) : {};
    const envConfig = envText ? dotenv.parse(envText) : {};
    const envLocalConfig = envLocalText ? dotenv.parse(envLocalText) : {};
    const mergedEnv = {
      ...envConfig,
      ...envLocalConfig,
      ...process.env
    };

    this.config = configSchema.parse(
      mergeConfig(yamlConfig, envToConfig(mergedEnv))
    ) as IConfig;
    await this.initCert();
  }

  private async saveConfig() {
    await fs.writeFile(configYamlPath, YAML.stringify(this.config), "utf8");
  }

  private async initCert() {
    if (this.config.jwt) {
      return;
    }

    const newKey = new NodeRSA({ b: 2048 });
    this.config.jwt = {
      privateKey: newKey.exportKey("private"),
      publicKey: newKey.exportKey("public")
    };
    await this.saveConfig();
  }
}
