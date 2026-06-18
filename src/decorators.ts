import {ConstructorRegistry, Registry} from "./consts.ts";
import type {RegistryType} from "./types.ts";
// @ts-ignore
Symbol.metadata ??= Symbol.for("Symbol.metadata");

function injectable() {
    return (_: any, context: DecoratorContext) => {
        context.metadata[Registry] ??= new Map() as RegistryType;
        context.metadata[ConstructorRegistry] ??= new Array<string | symbol | null>();
    }
}

function injectConstructor(...args: Array<string | symbol | null>) {
    return (_: any, context: DecoratorContext) => {
        context.metadata[ConstructorRegistry] = args;
    };
}

function injectProperty(arg: string | symbol | null) {
    return (val:any, context: DecoratorContext) => {
        if (arg === null) {
            return;
        }
        if (context.kind!=='field'){
            return;
        }

        context.metadata[Registry] ??= new Map() as RegistryType;

        const cupRegistry = context.metadata[ConstructorRegistry] as RegistryType;

        cupRegistry.set(context.name, arg);
        console.log(val)
    };
}
