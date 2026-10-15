/** Russian singular / paucal / plural, including the 11–14 exception. */
export function russianNoun(count: number, forms: readonly [string, string, string]): string {
  const value = Math.abs(Math.trunc(count));
  const lastTwo = value % 100;
  return forms[lastTwo >= 11 && lastTwo <= 14 ? 2 : value % 10 === 1 ? 0 : value % 10 >= 2 && value % 10 <= 4 ? 1 : 2];
}

export function russianCount(count: number, forms: readonly [string, string, string]): string {
  return `${count} ${russianNoun(count, forms)}`;
}
