import { z } from "zod";

export const configSchema = z.object({
  listen: z.object({
    port: z.coerce.number().int().min(1).max(65535),
    hostname: z.string().min(1)
  }),
  env: z.enum(["development", "production"]),
  jwt: z
    .object({
      privateKey: z.string().min(1),
      publicKey: z.string().min(1)
    })
    .optional()
});

export type AppEnv = z.infer<typeof configSchema>["env"];

export type IConfig = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
export type ConfigSource = Partial<{
  listen: Partial<ConfigInput["listen"]>;
  env: ConfigInput["env"] | string;
  jwt: Partial<NonNullable<ConfigInput["jwt"]>>;
}>;
