export function extractImports(code: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+.+?\s+from\s+["']([^"']+)["']/g,
    /require\(["']([^"']+)["']\)/g
  ];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) imports.add(match[1]);
    }
  }

  return [...imports].slice(0, 40);
}
