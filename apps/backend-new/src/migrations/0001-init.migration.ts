import type { MigrationFn } from "umzug";

export const up: MigrationFn<object> = async () => {
  console.log("Running initial backend-new migration");
};

export const down: MigrationFn<object> = async () => {
  console.log("Reverting initial backend-new migration");
};
