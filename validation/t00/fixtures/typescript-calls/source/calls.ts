// café: CRLF and non-ASCII bytes are intentional.
type Action = { run(): void };
const first: Action = { run() {} };
const second: Action = { run() {} };
export function twice(value: number) { return value * 2; }
export function direct() { return twice(2); }
export function indirect(action: Action) { action.run(); }
declare const receiver: any;
export function dynamic(name: string) { receiver[name](); }
