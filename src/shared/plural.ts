/** Bulgarian count agreement: one form for 1, the plural form otherwise ("1 страница", "3 страници"). */
export const bgCount = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
