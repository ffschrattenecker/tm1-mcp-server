/**
 * A TI variable name as TM1 accepts it. Besides letters, digits and `_`,
 * the compiler takes `.`, `$`, `%` and backtick (measured on 11.8 and 12.5:
 * `v.A = 1;`, `v$A`, `v%A` and `` v`A `` all compile), and ODBC columns
 * carry such names into data-source variables. A plain `\w` identifier made
 * the parser reject those lines, and every analysis then saw an empty tab.
 *
 * Function names stay `\w`-only; this is for variables.
 */
export const TI_VAR = "[A-Za-z_][\\w.$%`]*";
