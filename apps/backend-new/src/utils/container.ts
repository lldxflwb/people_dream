import { multi } from "itertools-ts";
import { getMetadataArgsStorage } from "routing-controllers";
import Container from "typedi";

export function containerRegister() {
  const allNeedRegister = multi.chain(
    getMetadataArgsStorage().controllers as { target: Function }[],
    getMetadataArgsStorage().middlewares,
    getMetadataArgsStorage().interceptors
  );

  for (const { target } of allNeedRegister) {
    if (!Container.has(target)) {
      Container.set({
        id: target,
        type: target as new () => unknown
      });
    }
  }
}
