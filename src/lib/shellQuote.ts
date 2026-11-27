// Minimal POSIX shell quoting: wrap in single quotes; escape internal single quotes.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function shellQuoteJoin(paths: string[]): string {
  return paths.map(shellQuote).join(" ");
}
