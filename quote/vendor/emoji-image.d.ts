export function withAssetRoot<T>(root:string|undefined,operation:()=>T):T;
export function currentAssetRoot():string|undefined;
export function clearAssetRoot(root:string|undefined):void;
