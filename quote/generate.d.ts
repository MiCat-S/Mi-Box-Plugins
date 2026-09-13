export function generateQuote(options:Record<string,unknown>):Promise<{image:Buffer;ext:string;width?:number;height?:number}>;
export function clearResources(root:string|undefined):void;
