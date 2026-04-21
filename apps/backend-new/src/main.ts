import "reflect-metadata";
import fs from "fs/promises";
import type { Server } from "http";
import path from "path";
import express from "express";
import { useContainer, useExpressServer } from "routing-controllers";
import { JSONStorage, Umzug } from "umzug";
import Container from "typedi";
import { ConfigService } from "./services/config.service";
import { containerRegister } from "./utils/container";

async function main() {
  const app = express();
  let server: Server | undefined;
  const configService = Container.get(ConfigService);
  await configService.loadConfig();

  const {
    listen: { hostname, port },
    env
  } = configService.config;

  const migrationsDir = path.join(__dirname, "./migrations");
  const migrationStatePath = path.join(migrationsDir, ".migrations.json");

  await fs.mkdir(migrationsDir, { recursive: true });

  const umzug = new Umzug({
    migrations: {
      glob: path.join(migrationsDir, "*.{migration,seed}.{ts,js}")
    },
    context: {},
    storage: new JSONStorage({
      path: migrationStatePath
    }),
    logger: console
  });

  await umzug.up();

  useExpressServer(app, {
    routePrefix: "/api",
    controllers: [path.join(__dirname, "./controllers/**/*.controller.ts")],
    middlewares: [path.join(__dirname, "./middlewares/**/*.middleware.ts")],
    defaultErrorHandler: false,
    classTransformer: true,
    validation: {
      stopAtFirstError: true
    },
    development: env === "development",
    defaults: {
      paramOptions: { required: true }
    }
  });

  useContainer(Container);
  containerRegister();

  server = app.listen(port, hostname, () => {
    console.log(`backend-new listening at http://${hostname}:${port}`);
  });

  return async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      server = undefined;
    }

    Container.reset();
  };
}

void main();
